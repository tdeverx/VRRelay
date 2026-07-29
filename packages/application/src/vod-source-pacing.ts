// SPDX-License-Identifier: GPL-3.0-or-later

export type VodProducerBufferState = 'catching_up' | 'buffered';

export interface VodProducerSourcePacing {
  readonly state: VodProducerBufferState;
  readonly rate: number;
  setRate(rate: number): void;
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
}
