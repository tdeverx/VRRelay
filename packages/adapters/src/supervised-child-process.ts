// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type SpawnChildProcess = (
  executable: string,
  arguments_: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface SupervisedChildProcessOptions {
  executable: string;
  arguments?: readonly string[];
  spawnOptions?: SpawnOptions;
  startupGraceMs?: number;
  gracefulStopMs?: number;
  maxStderrBytes?: number;
  redact?: (value: string) => string;
  onUnexpectedExit?: (error: Error) => void;
  spawnChild?: SpawnChildProcess;
}

function exitDescription(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? (code === null ? 'unknown' : String(code));
}

export async function terminateChildProcess(
  child: ChildProcess,
  gracefulStopMs = 3_000
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let exitListener!: () => void;
  const exited = new Promise<void>((resolve) => {
    exitListener = resolve;
    child.once('exit', exitListener);
  });
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, gracefulStopMs);
  killTimer.unref();
  let terminalTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_resolve, reject) => {
        terminalTimer = setTimeout(
          () => reject(new Error('Managed process did not exit after SIGKILL')),
          gracefulStopMs + 1_000
        );
        terminalTimer.unref();
      })
    ]);
  } finally {
    clearTimeout(killTimer);
    if (terminalTimer) clearTimeout(terminalTimer);
    child.off('exit', exitListener);
  }
}

/**
 * Owns one long-running child and applies the same startup, diagnostic, abort,
 * and TERM-to-KILL lifecycle used by managed media processes.
 */
export class SupervisedChildProcess {
  #child: ChildProcess | undefined;
  #stopping = false;
  #stderr = '';
  #abortSignal: AbortSignal | undefined;
  #abortListener: (() => void) | undefined;

  constructor(private readonly options: SupervisedChildProcessOptions) {}

  running(): boolean {
    const child = this.#child;
    return Boolean(child && child.exitCode === null && child.signalCode === null);
  }

  recentStderr(): string {
    const value = this.#stderr.trim();
    return this.options.redact ? this.options.redact(value) : value;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.running()) return;
    if (signal?.aborted) throw new Error('Managed process startup was aborted');

    this.#stopping = false;
    this.#stderr = '';
    const spawnChild =
      this.options.spawnChild ??
      ((executable, arguments_, options) => spawn(executable, arguments_, options));
    const child = spawnChild(
      this.options.executable,
      this.options.arguments ?? [],
      this.options.spawnOptions ?? { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    this.#child = child;
    let startupComplete = false;
    const maxStderrBytes = this.options.maxStderrBytes ?? 32_768;
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.#stderr = `${this.#stderr}${String(chunk)}`.slice(-maxStderrBytes);
    });

    if (signal) {
      this.#abortSignal = signal;
      this.#abortListener = () => void this.stop();
      signal.addEventListener('abort', this.#abortListener, { once: true });
    }

    child.once('exit', (code, exitSignal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#removeAbortListener();
      if (this.#stopping || !startupComplete) return;
      const detail = this.recentStderr();
      this.options.onUnexpectedExit?.(
        new Error(
          `Managed process exited unexpectedly (${exitDescription(code, exitSignal)})${
            detail ? `: ${detail}` : ''
          }`
        )
      );
    });
    child.on('error', (error) => {
      if (this.#child !== child || this.#stopping || !startupComplete) return;
      this.#child = undefined;
      this.#removeAbortListener();
      this.options.onUnexpectedExit?.(
        new Error(`Managed process failed after startup: ${error.message}`)
      );
    });

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const settle = (operation: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          child.off('error', onError);
          child.off('exit', onExit);
          child.off('spawn', onSpawn);
          operation();
        };
        const onError = (error: Error) =>
          settle(() => reject(new Error(`Managed process could not be started: ${error.message}`)));
        const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) =>
          settle(() =>
            reject(
              new Error(
                `Managed process exited during startup (${exitDescription(code, exitSignal)})${
                  this.recentStderr() ? `: ${this.recentStderr()}` : ''
                }`
              )
            )
          );
        const completeStartup = () =>
          settle(() => {
            startupComplete = true;
            resolve();
          });
        const onSpawn = () => {
          const startupGraceMs = this.options.startupGraceMs ?? 0;
          if (startupGraceMs === 0) completeStartup();
          else {
            timer = setTimeout(completeStartup, startupGraceMs);
            timer.unref();
          }
        };
        child.once('error', onError);
        child.once('exit', onExit);
        child.once('spawn', onSpawn);
      });
    } catch (error) {
      if (this.#child === child) this.#child = undefined;
      this.#removeAbortListener();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    this.#removeAbortListener();
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      if (this.#child === child) this.#child = undefined;
      return;
    }
    await terminateChildProcess(child, this.options.gracefulStopMs);
    if (this.#child === child) this.#child = undefined;
  }

  #removeAbortListener(): void {
    if (this.#abortSignal && this.#abortListener)
      this.#abortSignal.removeEventListener('abort', this.#abortListener);
    this.#abortSignal = undefined;
    this.#abortListener = undefined;
  }
}
