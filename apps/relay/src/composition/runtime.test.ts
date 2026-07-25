// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { NodeCapability, ProviderBinding, ProviderConnection } from '@vrrelay/domain';
import type { NodeAgentOptions } from '../agent-transport.js';
import { loadConfig } from '../config.js';
import {
  advertisedIngestUrl,
  configuredNodeAgentOptions,
  locallyAvailableProviderIds,
  startCriticalResourcesBeforeHttp
} from './runtime.js';

const capabilities = async (): Promise<NodeCapability> => ({
  encoders: [],
  hardwareDevices: [],
  maxWorkers: 0,
  activeWorkers: 0,
  queuedWorkers: 0,
  cacheBytes: 0,
  cacheLimitBytes: 0,
  egressMbps: 0,
  providerIds: [],
  vodProducerVersion: 0
});

describe('runtime public routing configuration', () => {
  it('replaces default loopback ingest hosts with the configured public hostname', () => {
    expect(advertisedIngestUrl('rtmp://127.0.0.1:1935', 'https://relay.example.test')).toBe(
      'rtmp://relay.example.test:1935'
    );
    expect(advertisedIngestUrl('srt://localhost:8890', 'https://relay.example.test')).toBe(
      'srt://relay.example.test:8890'
    );
    expect(advertisedIngestUrl('http://127.0.0.1:8889', 'https://relay.example.test')).toBe(
      'http://relay.example.test:8889'
    );
  });

  it('preserves explicitly configured non-loopback ingest endpoints', () => {
    expect(
      advertisedIngestUrl('rtmp://ingest.example.test:1935', 'https://relay.example.test')
    ).toBe('rtmp://ingest.example.test:1935');
  });

  it('advertises the playback origin to the controller when origins are distinct', () => {
    const config = loadConfig({
      VRRELAY_PUBLIC_URL: 'https://relay.example.test',
      VRRELAY_ADMIN_URL: 'https://admin.example.test',
      VRRELAY_PLAYBACK_URL: 'https://play.example.test',
      VRRELAY_CONTROLLER_AGENT_URL: 'wss://controller.example.test/agent',
      VRRELAY_CONTROLLER_ENROLLMENT_URL: 'https://controller.example.test/enroll'
    });
    const handlers: Pick<NodeAgentOptions, 'onSegment' | 'onCancel' | 'onProvider' | 'onCache'> = {
      onSegment: async () => undefined,
      onCancel: async () => undefined,
      onProvider: async () => ({}),
      onCache: async () => ({})
    };
    const options = configuredNodeAgentOptions(
      config,
      {
        put: async () => undefined,
        get: async () => {
          throw new Error('not configured');
        },
        delete: async () => undefined
      },
      capabilities,
      handlers
    );

    expect(options).toMatchObject({
      publicUrl: 'https://play.example.test',
      controllerUrl: 'wss://controller.example.test/agent',
      enrollmentUrl: 'https://controller.example.test/enroll'
    });
  });
});

describe('local provider capability discovery', () => {
  it('includes legacy provider secrets and local bindings while excluding unavailable secrets', async () => {
    const provider = (id: string, secretRef: string) => ({ id, secretRef }) as ProviderConnection;
    const binding = (providerId: string, secretRef: string, deletionPending = false) =>
      ({ providerId, secretRef, deletionPending }) as ProviderBinding;
    const available = new Set(['provider:legacy', 'binding:local']);

    await expect(
      locallyAvailableProviderIds(
        {
          listProviders: async () => [
            provider('legacy', 'provider:legacy'),
            provider('remote', 'provider:remote')
          ],
          listProviderBindings: async () => [
            binding('legacy', 'binding:local'),
            binding('deleted', 'binding:deleted', true)
          ]
        },
        {
          get: async (key) => {
            if (!available.has(key)) throw new Error('unavailable');
            return 'secret';
          }
        }
      )
    ).resolves.toEqual(['legacy']);
  });
});

describe('runtime startup ordering', () => {
  it('starts every critical resource before exposing public HTTP', async () => {
    const calls: string[] = [];
    await startCriticalResourcesBeforeHttp(
      [async () => void calls.push('media'), async () => void calls.push('agent')],
      async () => void calls.push('http')
    );
    expect(calls).toEqual(['media', 'agent', 'http']);
  });

  it('does not expose public HTTP when a critical resource fails', async () => {
    const expose = vi.fn(async () => undefined);
    await expect(
      startCriticalResourcesBeforeHttp(
        [
          async () => {
            throw new Error('agent failed');
          }
        ],
        expose
      )
    ).rejects.toThrow('agent failed');
    expect(expose).not.toHaveBeenCalled();
  });
});
