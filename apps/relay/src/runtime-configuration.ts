// SPDX-License-Identifier: GPL-3.0-or-later
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RuntimeConfiguration } from '@vrrelay/contracts';
import type { RelayConfig } from './config.js';
import { validateRuntimeConfiguration } from './config.js';

export interface PublicRuntimeConfiguration {
  configuration: RuntimeConfiguration;
  writable: boolean;
  restartSupported: boolean;
  restartRequired: boolean;
  environment: RelayConfig['environment'];
  version: string;
}

export function publicRuntimeConfiguration(
  config: RelayConfig,
  restartRequired = false
): PublicRuntimeConfiguration {
  return {
    configuration: {
      logLevel: config.logLevel === 'debug' || config.logLevel === 'trace' ? 'debug' : 'info',
      listenAddr: config.listenAddr,
      publicUrl: config.publicUrl,
      adminUrl: config.adminUrl,
      playbackUrl: config.playbackUrl,
      trustedProxyCidrs: config.trustedProxyCidrs,
      viewerRegionHeader: config.viewerRegionHeader,
      agentListenAddr: config.agentListenAddr,
      maxWorkers: config.maxWorkers,
      cacheTtlMs: config.cacheTtlMs,
      cacheLimitBytes: config.cacheLimitBytes,
      vodProducerIdleTimeoutMs: config.vodProducerIdleTimeoutMs,
      vodProducerBufferLowWatermarkMs: config.vodProducerBufferLowWatermarkMs,
      vodProducerBufferHighWatermarkMs: config.vodProducerBufferHighWatermarkMs,
      vodProducerCatchupRate: config.vodProducerCatchupRate,
      vodProducerEncoder: config.vodProducerEncoder,
      vodProducerMaxConcurrent: config.vodProducerMaxConcurrent,
      vodProducerMaxPerProvider: config.vodProducerMaxPerProvider,
      nodeName: config.nodeName,
      nodeRegion: config.nodeRegion
    },
    writable: Boolean(config.runtimeConfigPath),
    restartSupported: config.restartMode === 'exit',
    restartRequired,
    environment: config.environment,
    version: config.applicationVersion
  };
}

export async function persistRuntimeConfiguration(
  config: RelayConfig,
  input: RuntimeConfiguration
): Promise<RuntimeConfiguration> {
  if (!config.runtimeConfigPath)
    throw new Error('Runtime configuration is managed by the deployment environment');
  const validated = validateRuntimeConfiguration(config, input);
  const path = config.runtimeConfigPath;
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  return validated;
}
