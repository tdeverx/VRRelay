// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { RelayConfig } from '../config.js';
import { runMigrations } from './migration.js';

describe('migration composition root', () => {
  it('creates only the repository, migrates, and closes it', async () => {
    const calls: string[] = [];
    await runMigrations({} as RelayConfig, () => {
      calls.push('create');
      return {
        migrate: async () => void calls.push('migrate'),
        close: async () => void calls.push('close')
      };
    });

    expect(calls).toEqual(['create', 'migrate', 'close']);
  });

  it('closes the repository when a migration fails', async () => {
    const calls: string[] = [];
    await expect(
      runMigrations({} as RelayConfig, () => ({
        migrate: async () => {
          calls.push('migrate');
          throw new Error('migration failed');
        },
        close: async () => void calls.push('close')
      }))
    ).rejects.toThrow('migration failed');

    expect(calls).toEqual(['migrate', 'close']);
  });
});
