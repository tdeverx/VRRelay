// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type {
  LiveService,
  MediaCapabilities,
  MetricsSink,
  SessionService
} from '@vrrelay/application';
import { loadConfig } from '../config.js';
import { createRoleServer } from './role-server.js';

const capabilities: MediaCapabilities = {
  ffmpegVersion: 'test',
  encoders: [],
  muxers: [],
  filters: [],
  pixelFormats: []
};
const metrics: MetricsSink = {
  contentType: 'text/plain',
  increment: () => undefined,
  gauge: () => undefined,
  observe: () => undefined,
  render: async () => ''
};

describe('data-plane role servers', () => {
  it('registers only the source-worker HTTP surface', async () => {
    const app = await createRoleServer(loadConfig({}), {
      kind: 'source-worker',
      sessions: {} as SessionService,
      capabilities,
      metrics
    });
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: '/internal/source/:token' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/internal/mediamtx/auth' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/play/:token/index.m3u8' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/providers' })).toBe(false);
    await app.close();
  });

  it('registers only the ingest-origin HTTP surface', async () => {
    const app = await createRoleServer(loadConfig({}), {
      kind: 'ingest-origin',
      live: {} as LiveService,
      capabilities,
      metrics
    });
    await app.ready();
    expect(app.hasRoute({ method: 'POST', url: '/internal/mediamtx/auth' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/internal/source/:token' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/play/:token/index.m3u8' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/providers' })).toBe(false);
    await app.close();
  });

  it('registers only the edge playback HTTP surface', async () => {
    const app = await createRoleServer(loadConfig({}), {
      kind: 'edge',
      sessions: {} as SessionService,
      capabilities,
      metrics
    });
    await app.ready();
    expect(app.hasRoute({ method: 'GET', url: '/play/:token/index.m3u8' })).toBe(true);
    expect(app.hasRoute({ method: 'GET', url: '/internal/source/:token' })).toBe(false);
    expect(app.hasRoute({ method: 'POST', url: '/internal/mediamtx/auth' })).toBe(false);
    expect(app.hasRoute({ method: 'GET', url: '/api/v1/providers' })).toBe(false);
    await app.close();
  });
});
