// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import {
  persistRuntimeConfiguration,
  publicRuntimeConfiguration
} from './runtime-configuration.js';

describe('runtime configuration', () => {
  it('publishes only editable non-secret settings', () => {
    const published = publicRuntimeConfiguration(
      loadConfig({
        VRRELAY_RUNTIME_CONFIG: '/private/runtime.json',
        VRRELAY_RESTART_MODE: 'exit',
        VRRELAY_MASTER_KEY: 'not-returned'
      })
    );
    expect(published).toMatchObject({ writable: true, restartSupported: true });
    expect(JSON.stringify(published)).not.toContain('/private/runtime.json');
    expect(JSON.stringify(published)).not.toContain('not-returned');
  });

  it('atomically persists a validated allowlisted configuration with private permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-runtime-write-'));
    const path = join(directory, 'runtime.json');
    const config = loadConfig({ VRRELAY_RUNTIME_CONFIG: path });
    const configuration = publicRuntimeConfiguration(config).configuration;
    try {
      await persistRuntimeConfiguration(config, { ...configuration, maxWorkers: 6 });
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ maxWorkers: 6 });
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);
      await expect(
        persistRuntimeConfiguration(config, { ...configuration, listenAddr: 'invalid' })
      ).rejects.toThrow();
      await expect(
        persistRuntimeConfiguration(config, {
          ...configuration,
          listenAddr: '192.0.2.20:8099'
        })
      ).resolves.toMatchObject({ listenAddr: '192.0.2.20:8099' });
      await expect(
        persistRuntimeConfiguration(config, {
          ...configuration,
          listenAddr: '[2001:db8::20]:8099'
        })
      ).resolves.toMatchObject({ listenAddr: '[2001:db8::20]:8099' });
      await expect(
        persistRuntimeConfiguration(config, {
          ...configuration,
          listenAddr: 'relay.example.test:8099'
        })
      ).rejects.toThrow(/literal IPv4 or IPv6 address/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
