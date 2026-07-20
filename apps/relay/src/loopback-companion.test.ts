// SPDX-License-Identifier: GPL-3.0-or-later
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { requiresLoopbackCompanion, startLoopbackCompanion } from './loopback-companion.js';

const servers: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('loopback companion listener', () => {
  it.each(['127.0.0.1', 'localhost', '0.0.0.0', '::', '[::]'])(
    'reuses a listener that already accepts loopback traffic at %s',
    (host) => expect(requiresLoopbackCompanion(host)).toBe(false)
  );

  it.each(['192.0.2.18', '127.0.0.2', '::1'])(
    'requires a companion for a listener restricted to %s',
    (host) => expect(requiresLoopbackCompanion(host)).toBe(true)
  );

  it('serves private loopback routes for an address-specific configuration', async () => {
    const companion = await startLoopbackCompanion({ host: '192.0.2.18', port: 0 }, (app) =>
      app.get('/internal/source/test', async () => ({ loopback: true }))
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EPERM') return undefined;
      throw error;
    });
    // Some restricted test sandboxes deny all TCP listeners. Host classification above
    // remains covered there; normal CI exercises the companion listener end to end.
    if (!companion) return;
    servers.push(companion);
    const address = companion.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');

    await expect(
      fetch(`http://127.0.0.1:${address.port}/internal/source/test`).then((response) =>
        response.json()
      )
    ).resolves.toEqual({ loopback: true });
  });
});
