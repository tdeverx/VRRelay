// SPDX-License-Identifier: GPL-3.0-or-later
import type { RelayConfig } from '../config.js';

export interface MigrationRepository {
  migrate(): Promise<void>;
  close(): void | Promise<void>;
}

export type MigrationRepositoryFactory = (config: RelayConfig) => MigrationRepository;

export async function runMigrations(
  config: RelayConfig,
  factory: MigrationRepositoryFactory
): Promise<void> {
  const repository = factory(config);
  try {
    await repository.migrate();
  } finally {
    await repository.close();
  }
}
