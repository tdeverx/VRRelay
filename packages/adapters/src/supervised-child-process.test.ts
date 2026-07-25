// SPDX-License-Identifier: GPL-3.0-or-later
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupervisedChildProcess } from './supervised-child-process.js';

interface FixtureChild extends ChildProcess {
  stderr: PassThrough;
  sentSignals: NodeJS.Signals[];
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function fixtureChild(exitOnTerm = true, exitOnKill = true): FixtureChild {
  const child = new EventEmitter() as FixtureChild;
  child.stderr = new PassThrough();
  child.sentSignals = [];
  child.exitCode = null;
  child.signalCode = null;
  child.kill = ((signal: NodeJS.Signals = 'SIGTERM') => {
    child.sentSignals.push(signal);
    if (exitOnTerm || (exitOnKill && signal === 'SIGKILL')) {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
    }
    return true;
  }) as ChildProcess['kill'];
  return child;
}

describe('supervised child process', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('captures bounded redacted stderr for an unexpected exit', async () => {
    const child = fixtureChild();
    let failure: Error | undefined;
    const process = new SupervisedChildProcess({
      executable: 'fixture',
      maxStderrBytes: 80,
      redact: (value) => value.replace(/token=[^\s]+/g, 'token=[REDACTED]'),
      spawnChild: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      onUnexpectedExit: (error) => {
        failure = error;
      }
    });

    await process.start();
    child.stderr.write(`${'noise '.repeat(30)}token=private-value`);
    child.exitCode = 3;
    child.emit('exit', 3, null);

    expect(process.running()).toBe(false);
    expect(process.recentStderr()).not.toContain('private-value');
    expect(process.recentStderr().length).toBeLessThanOrEqual(80);
    expect(failure?.message).toContain('token=[REDACTED]');
  });

  it('escalates an unresponsive child from TERM to KILL', async () => {
    vi.useFakeTimers();
    const child = fixtureChild(false);
    const process = new SupervisedChildProcess({
      executable: 'fixture',
      gracefulStopMs: 50,
      spawnChild: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }
    });
    await process.start();

    const stopping = process.stop();
    expect(child.sentSignals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(50);
    await stopping;

    expect(child.sentSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('fails within a bound when a child reports no exit after SIGKILL', async () => {
    vi.useFakeTimers();
    const child = fixtureChild(false, false);
    const process = new SupervisedChildProcess({
      executable: 'fixture',
      gracefulStopMs: 50,
      spawnChild: () => {
        queueMicrotask(() => child.emit('spawn'));
        return child;
      }
    });
    await process.start();

    const stopping = process.stop();
    const failure = expect(stopping).rejects.toThrow('did not exit after SIGKILL');
    await vi.advanceTimersByTimeAsync(1_050);

    await failure;
    expect(child.sentSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
