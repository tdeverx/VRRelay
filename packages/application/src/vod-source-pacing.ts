// SPDX-License-Identifier: GPL-3.0-or-later
import { Readable } from 'node:stream';

export type VodProducerBufferState = 'catching_up' | 'buffered';

export interface VodProducerSourcePacing {
  readonly state: VodProducerBufferState;
  pause(): void;
  resume(): void;
  wait(signal?: AbortSignal): Promise<void>;
}

export class VodProducerSourcePacer implements VodProducerSourcePacing {
  #state: VodProducerBufferState = 'catching_up';
  #resumePromise: Promise<void> | undefined;
  #resume: (() => void) | undefined;

  get state(): VodProducerBufferState {
    return this.#state;
  }

  pause(): void {
    if (this.#state === 'buffered') return;
    this.#state = 'buffered';
    this.#resumePromise = new Promise<void>((resolve) => {
      this.#resume = resolve;
    });
  }

  resume(): void {
    if (this.#state === 'catching_up') return;
    this.#state = 'catching_up';
    this.#resume?.();
    this.#resume = undefined;
    this.#resumePromise = undefined;
  }

  async wait(signal?: AbortSignal): Promise<void> {
    while (this.#state === 'buffered') {
      if (signal?.aborted) throw signal.reason ?? new Error('Source pacing was aborted');
      const resumed = this.#resumePromise;
      if (!resumed) continue;
      if (!signal) {
        await resumed;
        continue;
      }
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(signal.reason ?? new Error('Source pacing was aborted'));
        signal.addEventListener('abort', aborted, { once: true });
        void resumed.then(
          () => {
            signal.removeEventListener('abort', aborted);
            resolve();
          },
          (error) => {
            signal.removeEventListener('abort', aborted);
            reject(error);
          }
        );
      });
    }
  }
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
