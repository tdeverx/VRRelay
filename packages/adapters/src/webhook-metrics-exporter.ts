// SPDX-License-Identifier: GPL-3.0-or-later
import type { BackendStatus } from '@vrrelay/domain';
import type { MetricsExporter, MetricsSink } from '@vrrelay/application';

export interface WebhookMetricsExporterOptions {
  endpoint: string;
  token?: string;
  intervalMs?: number;
  timeoutMs?: number;
}

interface HealthResponse {
  healthy?: boolean;
  message?: string;
}

export class WebhookMetricsExporter implements MetricsExporter {
  readonly kind = 'webhook';
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #lastPushError: string | undefined;

  constructor(
    private readonly metrics: MetricsSink,
    private readonly options: WebhookMetricsExporterOptions
  ) {
    this.#intervalMs = options.intervalMs ?? 30_000;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async health(): Promise<BackendStatus> {
    try {
      const response = await this.#request({ type: 'health' });
      const payload = (await response.json()) as HealthResponse;
      const webhookHealthy = payload?.healthy === true;
      const healthy = webhookHealthy && !this.#lastPushError;
      return {
        category: 'metrics',
        kind: 'webhook',
        healthy,
        message: this.#lastPushError
          ? `Most recent metrics push failed: ${this.#lastPushError}`
          : (payload?.message ??
            (webhookHealthy
              ? 'Metrics webhook reachable'
              : 'Metrics webhook health response did not confirm readiness')),
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      return {
        category: 'metrics',
        kind: 'webhook',
        healthy: false,
        message: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString()
      };
    }
  }

  start(): void {
    if (this.#timer) return;
    this.#schedulePush();
    this.#timer = setInterval(() => this.#schedulePush(), this.#intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    const inFlight = this.#inFlight;
    await inFlight;
  }

  #schedulePush(): void {
    if (this.#inFlight) return;
    this.#inFlight = this.#push()
      .then(() => {
        this.#lastPushError = undefined;
      })
      .catch((error: unknown) => {
        this.#lastPushError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
  }

  async #push(): Promise<void> {
    const response = await this.#request({
      type: 'metrics',
      timestamp: new Date().toISOString(),
      contentType: this.metrics.contentType,
      payload: await this.metrics.render()
    });
    await response.body?.cancel();
  }

  async #request(body: object): Promise<Response> {
    const response = await fetch(this.options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
      redirect: 'error'
    });
    if (!response.ok) throw new Error(`Metrics webhook returned HTTP ${response.status}`);
    return response;
  }
}
