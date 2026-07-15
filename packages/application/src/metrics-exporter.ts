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
    this.#delegate = next;
    await previous?.stop();
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
    this.#delegate = undefined;
    await current?.stop();
  }
}
