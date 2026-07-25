// SPDX-License-Identifier: GPL-3.0-or-later

export interface ShutdownStep {
  name: string;
  stop: () => void | Promise<void>;
  timeoutMs?: number;
}

export interface ShutdownSequence {
  readonly order: readonly string[];
  run(): Promise<void>;
}

export interface StartupRollback {
  defer(step: ShutdownStep): void;
  commit(): void;
  rollback(error: unknown): Promise<never>;
}

export function createShutdownSequence(steps: readonly ShutdownStep[]): ShutdownSequence {
  const sequence = [...steps];
  let running: Promise<void> | undefined;
  return {
    order: sequence.map((step) => step.name),
    run() {
      running ??= (async () => {
        const failures: Error[] = [];
        for (const step of sequence) {
          let timer: NodeJS.Timeout | undefined;
          try {
            const timeoutMs = step.timeoutMs ?? 15_000;
            await Promise.race([
              Promise.resolve().then(() => step.stop()),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error(`Shutdown step timed out: ${step.name}`)),
                  timeoutMs
                );
                timer.unref();
              })
            ]);
          } catch (error) {
            failures.push(
              new Error(`Shutdown step failed: ${step.name}`, {
                cause: error
              })
            );
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        if (failures.length > 0)
          throw new AggregateError(failures, 'One or more shutdown steps failed');
      })();
      return running;
    }
  };
}

export function createStartupRollback(): StartupRollback {
  const steps: ShutdownStep[] = [];
  return {
    defer(step) {
      steps.push(step);
    },
    commit() {
      steps.length = 0;
    },
    async rollback(startupError) {
      try {
        await createShutdownSequence([...steps].reverse()).run();
      } catch (rollbackError) {
        throw new AggregateError(
          [startupError, rollbackError],
          'VRRelay startup failed and one or more rollback steps also failed',
          { cause: rollbackError }
        );
      }
      throw startupError;
    }
  };
}
