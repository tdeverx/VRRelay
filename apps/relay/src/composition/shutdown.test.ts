// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createShutdownSequence } from './shutdown.js';

describe('shutdown sequence', () => {
  it('stops resources once in the declared order', async () => {
    const calls: string[] = [];
    const shutdown = createShutdownSequence([
      { name: 'timers', stop: () => void calls.push('timers') },
      {
        name: 'agents',
        stop: async () => {
          await Promise.resolve();
          calls.push('agents');
        }
      },
      { name: 'repository', stop: () => void calls.push('repository') }
    ]);

    expect(shutdown.order).toEqual(['timers', 'agents', 'repository']);
    const first = shutdown.run();
    const second = shutdown.run();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await shutdown.run();

    expect(calls).toEqual(['timers', 'agents', 'repository']);
  });
});
