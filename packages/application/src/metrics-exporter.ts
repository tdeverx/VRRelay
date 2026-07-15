// SPDX-License-Identifier: GPL-3.0-or-later
import type { BackendStatus } from '@vrrelay/domain';
import type { MetricsExporter } from './index.js';

export class SwitchableMetricsExporter {
  #delegate: MetricsExporter | undefined;

  get kind(): string {
    return this.#delegate?.kind ?? 'prometheus';
  }

  async activate(next?: MetricsExporter): Promise<void> {
    const previous = this.#delegate;
    if (previous === next) return;
    next?.start();
    try {
      await previous?.stop();
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (next) {
        try {
          await next.stop();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (previous) {
        try {
          previous.start();
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length)
        throw new AggregateError(
          [error, ...rollbackErrors],
          'Metrics exporter activation failed and rollback was incomplete',
          { cause: error }
        );
      throw error;
    }
    this.#delegate = next;
  }

  async health(): Promise<BackendStatus> {
    if (this.#delegate) return this.#delegate.health();
    return {
      category: 'metrics',
      kind: 'prometheus',
      healthy: true,
      message: 'Prometheus exposition endpoint active',
      checkedAt: new Date().toISOString()
    };
  }

  async stop(): Promise<void> {
    const current = this.#delegate;
    if (!current) return;
    await current.stop();
    if (this.#delegate === current) this.#delegate = undefined;
  }
}
