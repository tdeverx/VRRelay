// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VodProducerSourcePacer } from './vod-source-pacing.js';

describe('VOD producer source pacing', () => {
  it('tracks the requested producer state without throttling opaque source chunks', () => {
    const pacing = new VodProducerSourcePacer(2);
    expect(pacing.rate).toBe(2);
    expect(pacing.state).toBe('catching_up');
    pacing.setRate(1);
    expect(pacing.rate).toBe(1);
    expect(pacing.state).toBe('buffered');
    expect(() => pacing.setRate(2.1)).toThrow(/between 1x and 2x/);
  });

  it('rejects invalid maximum rates', () => {
    expect(() => new VodProducerSourcePacer(0.9)).toThrow(/between 1x and 2x/);
    expect(() => new VodProducerSourcePacer(2.1)).toThrow(/between 1x and 2x/);
  });
});
