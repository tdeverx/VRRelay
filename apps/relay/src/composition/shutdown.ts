// SPDX-License-Identifier: GPL-3.0-or-later

export interface ShutdownStep {
  name: string;
  stop: () => void | Promise<void>;
}

export interface ShutdownSequence {
  readonly order: readonly string[];
  run(): Promise<void>;
}

export function createShutdownSequence(steps: readonly ShutdownStep[]): ShutdownSequence {
  const sequence = [...steps];
  let running: Promise<void> | undefined;
  return {
    order: sequence.map((step) => step.name),
    run() {
      running ??= (async () => {
        for (const step of sequence) await step.stop();
      })();
      return running;
    }
  };
}
