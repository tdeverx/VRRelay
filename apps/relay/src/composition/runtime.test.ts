// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { NodeCapability } from '@vrrelay/domain';
import type { NodeAgentOptions } from '../agent-transport.js';
import { loadConfig } from '../config.js';
import { configuredNodeAgentOptions } from './runtime.js';

const capabilities = async (): Promise<NodeCapability> => ({
  encoders: [],
  hardwareDevices: [],
  maxWorkers: 0,
  activeWorkers: 0,
  queuedWorkers: 0,
  cacheBytes: 0,
  cacheLimitBytes: 0,
  egressMbps: 0,
  providerIds: []
});

describe('runtime public routing configuration', () => {
  it('advertises the playback origin to the controller when origins are distinct', () => {
    const config = loadConfig({
      VRRELAY_PUBLIC_URL: 'https://relay.example.test',
      VRRELAY_ADMIN_URL: 'https://admin.example.test',
      VRRELAY_PLAYBACK_URL: 'https://play.example.test',
      VRRELAY_CONTROLLER_AGENT_URL: 'wss://controller.example.test/agent',
      VRRELAY_CONTROLLER_ENROLLMENT_URL: 'https://controller.example.test/enroll'
    });
    const handlers: Pick<NodeAgentOptions, 'onSegment' | 'onCancel' | 'onProvider'> = {
      onSegment: async () => undefined,
      onCancel: async () => undefined,
      onProvider: async () => ({})
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
