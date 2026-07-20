// SPDX-License-Identifier: GPL-3.0-or-later
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pacedReadable, VodProducerSourcePacer } from './vod-source-pacing.js';

describe('VOD producer source pacing', () => {
  it('backpressures the source while buffered and resumes the same stream', async () => {
    const pacing = new VodProducerSourcePacer();
    pacing.pause();
    const output = pacedReadable(Readable.from([Buffer.from('one'), Buffer.from('two')]), pacing);
    const completed = output.toArray();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pacing.state).toBe('buffered');
    let settled = false;
    void completed.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    pacing.resume();
    expect(Buffer.concat(await completed).toString()).toBe('onetwo');
    expect(pacing.state).toBe('catching_up');
  });

  it('releases a paused reader when its request is aborted', async () => {
    const pacing = new VodProducerSourcePacer();
    const controller = new AbortController();
    pacing.pause();
    const output = pacedReadable(Readable.from([Buffer.from('held')]), pacing, controller.signal);
    const completed = output.toArray();
    controller.abort(new Error('test abort'));
    await expect(completed).rejects.toThrow('test abort');
  });
});
