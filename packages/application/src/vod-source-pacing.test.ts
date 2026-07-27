// SPDX-License-Identifier: GPL-3.0-or-later
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pacedReadable, VodProducerSourcePacer } from './vod-source-pacing.js';

describe('VOD producer source pacing', () => {
  it('scales one source stream from its maximum rate back to playback speed', async () => {
    const pacing = new VodProducerSourcePacer(2);
    expect(pacing.rate).toBe(2);
    expect(pacing.state).toBe('catching_up');
    pacing.setRate(1);
    expect(pacing.rate).toBe(1);
    expect(pacing.state).toBe('buffered');
    const output = pacedReadable(Readable.from([Buffer.from('one'), Buffer.from('two')]), pacing);
    expect(Buffer.concat(await output.toArray()).toString()).toBe('onetwo');
    expect(() => pacing.setRate(2.1)).toThrow(/between 1x and 2x/);
  });

  it('rejects a paced reader when its request is aborted', async () => {
    const pacing = new VodProducerSourcePacer(2);
    const controller = new AbortController();
    pacing.setRate(1);
    controller.abort(new Error('test abort'));
    await expect(pacing.wait(controller.signal)).rejects.toThrow('test abort');
  });
});
