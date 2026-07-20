// SPDX-License-Identifier: GPL-3.0-or-later
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { UNSAFE_PUBLIC_HTTP_SECURITY_NOTICE, type ProviderConnection } from '@vrrelay/domain';
import { CatalogQuerySchema } from '@vrrelay/contracts';
import { JellyfinProvider, type JellyfinConnectorRequest } from './jellyfin-provider.js';
import { resolveProviderRequestTarget, validateProviderUrl } from './network-policy.js';

function response(
  statusCode: number,
  body = '',
  headers: IncomingMessage['headers'] = {}
): IncomingMessage {
  return Object.assign(Readable.from(body ? [body] : []), {
    statusCode,
    headers
  }) as IncomingMessage;
}

describe('Jellyfin request transport', () => {
  it('maps provider-neutral home sections to Jellyfin feeds and user progress', async () => {
    const requests: JellyfinConnectorRequest[] = [];
    const provider = new JellyfinProvider('0.1.0', {
      resolveTarget: (rawUrl) =>
        resolveProviderRequestTarget(rawUrl, async () => [{ address: '203.0.113.10', family: 4 }]),
      requestConnector: async (request) => {
        requests.push(request);
        return response(
          200,
          JSON.stringify({
            Items: [
              {
                Id: 'episode-1',
                Name: 'A New Episode',
                Type: 'Episode',
                RunTimeTicks: 3_600_000_000,
                MediaSources: [{ Id: 'episode-source' }],
                UserData: { PlaybackPositionTicks: 900_000_000, PlayedPercentage: 25 }
              }
            ],
            TotalRecordCount: 1
          }),
          { 'content-type': 'application/json' }
        );
      }
    });
    const now = new Date().toISOString();
    const connection = {
      id: 'provider',
      type: 'jellyfin',
      name: 'Jellyfin',
      baseUrl: 'https://jellyfin.invalid',
      authMode: 'delegated',
      secretRef: 'provider:delegated',
      userId: 'user-1',
      capabilities: ['search'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    } satisfies ProviderConnection;

    const result = await provider.browse(
      connection,
      'sensitive-user-token',
      CatalogQuerySchema.parse({ section: 'continue_watching', limit: 16 })
    );
    await provider.browse(
      connection,
      'sensitive-user-token',
      CatalogQuerySchema.parse({ section: 'next_up', limit: 16 })
    );
    await provider.browse(
      connection,
      'sensitive-user-token',
      CatalogQuerySchema.parse({ section: 'recently_added', limit: 24 })
    );

    expect(result.items[0]).toMatchObject({
      id: 'episode-1',
      playbackPositionSeconds: 90,
      playedPercentage: 25
    });
    expect(requests.map((request) => request.url.pathname)).toEqual([
      '/Users/user-1/Items/Resume',
      '/Shows/NextUp',
      '/Users/user-1/Items'
    ]);
    expect(requests[1]?.url.searchParams.get('UserId')).toBe('user-1');
    expect(requests[2]?.url.searchParams.get('IncludeItemTypes')).toBe('Movie,Episode');
    expect(requests[0]?.url.searchParams.get('ExcludeLocationTypes')).toBe('Virtual');
    expect(requests[0]?.url.searchParams.get('IsMissing')).toBe('false');
    expect(requests[0]?.url.searchParams.get('IsPlaceHolder')).toBe('false');
  });

  it('omits catalog entries that have no playable media files', async () => {
    const provider = new JellyfinProvider('0.1.0', {
      resolveTarget: (rawUrl) =>
        resolveProviderRequestTarget(rawUrl, async () => [{ address: '203.0.113.10', family: 4 }]),
      requestConnector: async () =>
        response(
          200,
          JSON.stringify({
            Items: [
              { Id: 'movie-ready', Name: 'Ready movie', Type: 'Movie', MediaSources: [{}] },
              { Id: 'movie-empty', Name: 'Empty movie', Type: 'Movie', MediaSources: [] },
              { Id: 'series-ready', Name: 'Ready show', Type: 'Series', RecursiveItemCount: 3 },
              { Id: 'series-empty', Name: 'Empty show', Type: 'Series', RecursiveItemCount: 0 },
              {
                Id: 'episode-virtual',
                Name: 'Virtual episode',
                Type: 'Episode',
                LocationType: 'Virtual',
                MediaSources: [{}]
              },
              {
                Id: 'movie-placeholder',
                Name: 'Placeholder movie',
                Type: 'Movie',
                IsPlaceHolder: true,
                MediaSources: [{}]
              }
            ],
            TotalRecordCount: 6
          }),
          { 'content-type': 'application/json' }
        )
    });
    const now = new Date().toISOString();
    const connection = {
      id: 'provider',
      type: 'jellyfin',
      name: 'Jellyfin',
      baseUrl: 'https://jellyfin.invalid',
      authMode: 'delegated',
      secretRef: 'provider:delegated',
      userId: 'user-1',
      capabilities: ['search'],
      healthy: true,
      createdAt: now,
      updatedAt: now
    } satisfies ProviderConnection;

    const result = await provider.browse(
      connection,
      'sensitive-user-token',
      CatalogQuerySchema.parse({ search: 'media', kinds: ['Movie', 'Series'] })
    );

    expect(result.items.map((item) => item.id)).toEqual(['movie-ready', 'series-ready']);
  });

  it('loads artwork through the pinned authenticated transport', async () => {
    const requests: JellyfinConnectorRequest[] = [];
    const provider = new JellyfinProvider('0.1.0', {
      resolveTarget: (rawUrl) =>
        resolveProviderRequestTarget(rawUrl, async () => [{ address: '203.0.113.10', family: 4 }]),
      requestConnector: async (request) => {
        requests.push(request);
        return response(200, 'fixture-image', { 'content-type': 'image/jpeg' });
      }
    });
    const now = new Date().toISOString();
    const connection = {
      id: 'provider',
      type: 'jellyfin',
      name: 'Jellyfin',
      baseUrl: 'https://jellyfin.invalid',
      authMode: 'delegated',
      secretRef: 'provider:delegated',
      capabilities: ['artwork'],
      healthy: true,
      allowPublicHttp: false,
      createdAt: now,
      updatedAt: now
    } satisfies ProviderConnection;

    await expect(provider.artwork(connection, 'sensitive-user-token', 'movie/1')).resolves.toEqual({
      data: Buffer.from('fixture-image'),
      contentType: 'image/jpeg'
    });
    expect(requests[0]?.url.pathname).toBe('/Items/movie%2F1/Images/Primary');
    expect(requests[0]?.options.headers).toMatchObject({
      Accept: 'image/*',
      'X-Emby-Token': 'sensitive-user-token'
    });
  });

  it('rejects private HTTP that resolves publicly on the pinned connection lookup', async () => {
    const addresses = ['192.168.10.20', '203.0.113.10'];
    const lookup = async () => [{ address: addresses.shift()!, family: 4 }];
    await expect(
      validateProviderUrl('http://jellyfin.invalid', false, lookup)
    ).resolves.toMatchObject({ privateNetwork: true });

    let connectorCalls = 0;
    const provider = new JellyfinProvider('0.1.0', {
      resolveTarget: (rawUrl) => resolveProviderRequestTarget(rawUrl, lookup),
      requestConnector: async () => {
        connectorCalls += 1;
        return response(500);
      }
    });
    await expect(
      provider.authenticate('http://jellyfin.invalid', { apiKey: 'sensitive-api-key' }, undefined, {
        allowPublicHttp: false
      })
    ).rejects.toThrow(/explicit unsafe approval/);
    expect(connectorCalls).toBe(0);
  });

  it('preserves explicitly approved public HTTP transport', async () => {
    const provider = new JellyfinProvider('0.1.0', {
      resolveTarget: (rawUrl) =>
        resolveProviderRequestTarget(rawUrl, async () => [{ address: '203.0.113.10', family: 4 }]),
      requestConnector: async ({ url }) =>
        url.pathname === '/System/Info/Public'
          ? response(200, JSON.stringify({ ServerName: 'Fixture', Version: '1.0.0' }))
          : response(204)
    });
    await expect(
      provider.authenticate('http://jellyfin.invalid', { apiKey: 'sensitive-api-key' }, undefined, {
        allowPublicHttp: true
      })
    ).resolves.toMatchObject({ accessToken: 'sensitive-api-key', serverName: 'Fixture' });
  });

  it('honors only the exact legacy unsafe-public notice when the policy field is absent', async () => {
    let connectorCalls = 0;
    const provider = new JellyfinProvider('0.1.0', {
      resolveTarget: (rawUrl) =>
        resolveProviderRequestTarget(rawUrl, async () => [{ address: '203.0.113.10', family: 4 }]),
      requestConnector: async () => {
        connectorCalls += 1;
        return response(204);
      }
    });
    const now = new Date().toISOString();
    const connection = {
      id: 'legacy-provider',
      type: 'jellyfin',
      name: 'Legacy provider',
      baseUrl: 'http://jellyfin.invalid',
      authMode: 'api_key',
      secretRef: 'provider:legacy',
      capabilities: [],
      healthy: true,
      createdAt: now,
      updatedAt: now
    } satisfies ProviderConnection;

    await expect(
      provider.validate(
        { ...connection, securityNotice: UNSAFE_PUBLIC_HTTP_SECURITY_NOTICE },
        'sensitive-api-key'
      )
    ).resolves.toBeUndefined();
    await expect(
      provider.validate(
        {
          ...connection,
          securityNotice: 'HTTP traffic remains unencrypted on the private network.'
        },
        'sensitive-api-key'
      )
    ).rejects.toThrow(/explicit unsafe approval/);
    expect(connectorCalls).toBe(1);
  });

  it('pins every connection and does not follow authenticated redirects', async () => {
    let resolutions = 0;
    const requests: JellyfinConnectorRequest[] = [];
    const provider = new JellyfinProvider('0.1.0', {
      resolveTarget: (rawUrl) =>
        resolveProviderRequestTarget(rawUrl, async (hostname) => {
          resolutions += 1;
          expect(hostname).toBe('jellyfin.invalid');
          return [{ address: '203.0.113.10', family: 4 }];
        }),
      requestConnector: async (request) => {
        requests.push(request);
        if (request.url.pathname === '/System/Info/Public') {
          return response(200, JSON.stringify({ ServerName: 'Fixture', Version: '1.0.0' }), {
            'content-type': 'application/json'
          });
        }
        if (request.url.pathname === '/System/Info') {
          return response(302, '', { location: 'https://redirect.invalid/credential-target' });
        }
        return response(204);
      }
    });
    await expect(
      provider.authenticate('https://jellyfin.invalid:8920', {
        apiKey: 'sensitive-api-key'
      })
    ).rejects.toThrow(/redirects are not allowed/);

    expect(resolutions).toBe(2);
    expect(requests).toHaveLength(2);
    expect(requests.map(({ url }) => url.pathname)).toEqual([
      '/System/Info/Public',
      '/System/Info'
    ]);
    for (const request of requests) {
      expect(request.url.hostname).toBe('jellyfin.invalid');
      expect(request.options.agent).toBe(false);
      expect(request.options.headers).toMatchObject({ Host: 'jellyfin.invalid:8920' });
      expect(request.options.servername).toBe('jellyfin.invalid');
      const lookup = request.options.lookup;
      expect(lookup).toBeTypeOf('function');
      const pinned = await new Promise<{ address: string; family: number }>((resolve, reject) => {
        lookup!('ignored.invalid', {}, (error, address, family) => {
          if (error) {
            reject(error);
            return;
          }
          if (typeof address !== 'string') {
            reject(new Error('Expected a single pinned address'));
            return;
          }
          if (typeof family !== 'number') {
            reject(new Error('Expected a pinned address family'));
            return;
          }
          resolve({ address, family });
        });
      });
      expect(pinned).toEqual({ address: '203.0.113.10', family: 4 });
    }
  });
});
