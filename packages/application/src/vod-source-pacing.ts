// SPDX-License-Identifier: GPL-3.0-or-later
import { Readable } from 'node:stream';

export type VodProducerBufferState = 'catching_up' | 'buffered';

export interface VodProducerSourcePacing {
  readonly state: VodProducerBufferState;
  readonly rate: number;
  setRate(rate: number): void;
  wait(signal?: AbortSignal): Promise<void>;
}

export class VodProducerSourcePacer implements VodProducerSourcePacing {
  #rate: number;

  constructor(readonly maximumRate = 2) {
    if (!Number.isFinite(maximumRate) || maximumRate < 1 || maximumRate > 2)
      throw new Error('The VOD producer maximum catch-up rate must be between 1x and 2x');
    this.#rate = maximumRate;
  }

  get state(): VodProducerBufferState {
    return this.#rate > 1 ? 'catching_up' : 'buffered';
  }

  get rate(): number {
    return this.#rate;
  }

  setRate(rate: number): void {
    if (!Number.isFinite(rate) || rate < 1 || rate > this.maximumRate)
      throw new Error(`The VOD producer catch-up rate must be between 1x and ${this.maximumRate}x`);
    this.#rate = rate;
  }

  async wait(signal?: AbortSignal): Promise<void> {
    // FFmpeg reads at this stream's configured maximum.  The proxy opens and
    // closes short windows to reduce the effective rate without restarting the
    // producer or its authenticated upstream connection.
    while (this.#rate < this.maximumRate) {
      if (signal?.aborted) throw signal.reason ?? new Error('Source pacing was aborted');
      const windowMs = 100;
      const elapsedMs = performance.now() % windowMs;
      const openForMs = windowMs * (this.#rate / this.maximumRate);
      if (elapsedMs < openForMs) return;
      const delayMs = Math.max(1, Math.ceil(windowMs - elapsedMs));
      await waitFor(delayMs, signal);
    }
  }
}

async function waitFor(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, delayMs);
    const aborted = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error('Source pacing was aborted'));
    };
    signal.addEventListener('abort', aborted, { once: true });
  });
}

export function pacedReadable(
  source: Readable,
  pacing: VodProducerSourcePacing,
  signal?: AbortSignal
): Readable {
  const output = Readable.from(
    (async function* () {
      for await (const chunk of source) {
        await pacing.wait(signal);
        yield chunk;
      }
    })(),
    { objectMode: false }
  );
  output.once('close', () => {
    if (!source.destroyed) source.destroy();
  });
  return output;
}
