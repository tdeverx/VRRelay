// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { JellyfinProvider } from './jellyfin-provider.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe('Jellyfin request transport', () => {
  it('does not follow authenticated redirects', async () => {
    let redirectedRequestSeen = false;
    const server = createServer((request, response) => {
      if (request.url === '/System/Info/Public') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ServerName: 'Fixture', Version: '1.0.0' }));
        return;
      }
      if (request.url === '/System/Info') {
        response.statusCode = 302;
        response.setHeader('location', '/credential-target');
        response.end();
        return;
      }
      if (request.url === '/credential-target') redirectedRequestSeen = true;
      response.statusCode = 204;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');

    const provider = new JellyfinProvider();
    await expect(
      provider.authenticate(`http://127.0.0.1:${address.port}`, { apiKey: 'sensitive-api-key' })
    ).rejects.toThrow(/redirects are not allowed/);
    expect(redirectedRequestSeen).toBe(false);
  });
});
