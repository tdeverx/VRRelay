// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdownSequence, createStartupRollback } from './shutdown.js';

describe('shutdown sequence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('continues after failures and reports every failed step', async () => {
    const calls: string[] = [];
    const shutdown = createShutdownSequence([
      {
        name: 'first',
        stop: () => {
          calls.push('first');
          throw new Error('first failure');
        }
      },
      {
        name: 'second',
        stop: () => {
          calls.push('second');
        }
      },
      {
        name: 'third',
        stop: async () => {
          calls.push('third');
          throw new Error('third failure');
        }
      }
    ]);

    const failure = await shutdown.run().catch((error: unknown) => error);
    expect(calls).toEqual(['first', 'second', 'third']);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
    expect((failure as AggregateError).errors.map((error) => String(error))).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('third')
    ]);
  });

  it('times out a stalled step and still closes later resources', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const shutdown = createShutdownSequence([
      {
        name: 'stalled',
        timeoutMs: 50,
        stop: () => new Promise<void>(() => undefined)
      },
      {
        name: 'repository',
        stop: () => {
          calls.push('repository');
        }
      }
    ]);

    const stopping = shutdown.run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    const failure = await stopping;

    expect(calls).toEqual(['repository']);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String((failure as AggregateError).errors[0])).toContain('stalled');
  });
});

describe('startup rollback', () => {
  it('releases constructed resources in reverse order and preserves the startup error', async () => {
    const calls: string[] = [];
    const startup = createStartupRollback();
    startup.defer({ name: 'repository', stop: () => void calls.push('repository') });
    startup.defer({ name: 'http', stop: () => void calls.push('http') });
    const startupError = new Error('listen failed');

    await expect(startup.rollback(startupError)).rejects.toBe(startupError);
    expect(calls).toEqual(['http', 'repository']);
  });

  it('aggregates rollback failures with the original startup error', async () => {
    const startup = createStartupRollback();
    startup.defer({
      name: 'repository',
      stop: () => {
        throw new Error('close failed');
      }
    });
    const failure = await startup.rollback(new Error('startup failed')).catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(2);
  });

  it('does not roll back resources after commit', async () => {
    const stop = vi.fn();
    const startup = createStartupRollback();
    startup.defer({ name: 'repository', stop });
    startup.commit();

    await expect(startup.rollback(new Error('late failure'))).rejects.toThrow('late failure');
    expect(stop).not.toHaveBeenCalled();
  });
});
