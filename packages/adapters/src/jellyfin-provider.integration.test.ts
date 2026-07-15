import { describe, expect, it } from 'vitest';
import { JellyfinProvider } from './jellyfin-provider.js';

const fixture =
  process.env.VRRELAY_TEST_JELLYFIN_URL &&
  process.env.VRRELAY_TEST_JELLYFIN_USER &&
  process.env.VRRELAY_TEST_JELLYFIN_PASSWORD;

describe.skipIf(!fixture)('Jellyfin provider integration', () => {
  it('authenticates, maps playable media, and supports ranged original-source access', async () => {
    const provider = new JellyfinProvider();
    const identity = await provider.authenticate(process.env.VRRELAY_TEST_JELLYFIN_URL!, {
      username: process.env.VRRELAY_TEST_JELLYFIN_USER!,
      password: process.env.VRRELAY_TEST_JELLYFIN_PASSWORD!
    });
    expect(identity.accessToken).toBeTruthy();
    const connection = {
      id: 'fixture',
      type: 'jellyfin' as const,
      name: 'Fixture',
      baseUrl: process.env.VRRELAY_TEST_JELLYFIN_URL!,
      authMode: 'user_token' as const,
      secretRef: 'ignored',
      userId: identity.userId,
      username: identity.username,
      capabilities: [...provider.capabilities],
      healthy: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await provider.validate(connection, identity.accessToken);
    const catalog = await provider.browse(connection, identity.accessToken, {
      kinds: ['Movie', 'Episode', 'Video'],
      limit: 25,
      offset: 0
    });
    expect(catalog.items.length).toBeGreaterThan(0);
    expect(catalog.items.every((item) => item.providerId === connection.id)).toBe(true);
    const item = await provider.item(connection, identity.accessToken, catalog.items[0]!.id);
    expect(item.id).toBeTruthy();
    expect(item.durationSeconds).toBeGreaterThan(0);
    expect(item.versions?.length).toBeGreaterThan(0);

    const source = await provider.resolveSource(connection, identity.accessToken, {
      providerId: connection.id,
      itemId: item.id,
      versionId: item.versions?.[0]?.id,
      audioTrackId: item.audioTracks?.find((track) => track.isDefault)?.id,
      subtitleTrackId: item.subtitleTracks?.find((track) => track.isDefault)?.id
    });
    expect(source.durationSeconds).toBeGreaterThan(0);
    expect(source.fingerprint).toBeTruthy();
    expect(source.url).toContain(`/Videos/${encodeURIComponent(item.id)}/stream?`);

    const opened = await provider.openSource(source, 'bytes=0-65535');
    expect([200, 206]).toContain(opened.status);
    expect(opened.headers['content-type']).toMatch(/^(video|application)\//);
    let received = 0;
    for await (const chunk of opened.stream) {
      received += Buffer.byteLength(chunk);
      if (received >= 1_024) {
        opened.stream.destroy();
        break;
      }
    }
    expect(received).toBeGreaterThanOrEqual(1_024);
  }, 20_000);
});
