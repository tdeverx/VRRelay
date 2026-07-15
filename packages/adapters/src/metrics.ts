// SPDX-License-Identifier: GPL-3.0-or-later
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { MetricsSink } from '@vrrelay/application';

function safe(name: string) {
  return `vrrelay_${name.replace(/[^a-zA-Z0-9_:]/g, '_')}`;
}

export class PrometheusMetricsSink implements MetricsSink {
  readonly contentType: string;
  readonly #registry = new Registry();
  readonly #counters = new Map<string, Counter>();
  readonly #gauges = new Map<string, Gauge>();
  readonly #histograms = new Map<string, Histogram>();

  constructor(defaultLabels: Record<string, string> = {}) {
    this.#registry.setDefaultLabels(defaultLabels);
    this.contentType = this.#registry.contentType;
  }

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = `${name}:${Object.keys(labels).sort().join(',')}`;
    let metric = this.#counters.get(key);
    if (!metric) {
      metric = new Counter({
        name: safe(name),
        help: `VRRelay ${name}`,
        labelNames: Object.keys(labels).sort(),
        registers: [this.#registry]
      });
      this.#counters.set(key, metric);
    }
    metric.inc(labels, value);
  }

  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = `${name}:${Object.keys(labels).sort().join(',')}`;
    let metric = this.#gauges.get(key);
    if (!metric) {
      metric = new Gauge({
        name: safe(name),
        help: `VRRelay ${name}`,
        labelNames: Object.keys(labels).sort(),
        registers: [this.#registry]
      });
      this.#gauges.set(key, metric);
    }
    metric.set(labels, value);
  }

  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = `${name}:${Object.keys(labels).sort().join(',')}`;
    let metric = this.#histograms.get(key);
    if (!metric) {
      metric = new Histogram({
        name: safe(name),
        help: `VRRelay ${name}`,
        labelNames: Object.keys(labels).sort(),
        registers: [this.#registry]
      });
      this.#histograms.set(key, metric);
    }
    metric.observe(labels, value);
  }

  async render(): Promise<string> {
    return this.#registry.metrics();
  }
}
