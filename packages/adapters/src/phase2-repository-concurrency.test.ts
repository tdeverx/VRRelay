// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ClusterNode,
  LiveChannel,
  NodeCertificateState,
  PersonalAccessToken,
  ProviderBinding,
  ProviderConnection,
  RelaySession,
  SegmentJob,
  UserIdentity
} from '@vrrelay/domain';
import type { ClusterRepository, Repository } from '@vrrelay/application';
import { PostgresRepository } from './postgres-repository.js';
import { SqliteRepository } from './sqlite-repository.js';

type ConcurrencyRepository = Pick<
  Repository,
  | 'createProvider'
  | 'getVersionedProvider'
  | 'compareAndSetProvider'
  | 'beginProviderDeletion'
  | 'finalizeProviderDeletion'
  | 'createSessionWithPlaybackGrant'
  | 'getPlaybackGrant'
  | 'getVersionedSession'
  | 'compareAndSetSession'
  | 'touchSessionPlaybackActivity'
  | 'listInactiveSessions'
  | 'beginSessionDeletion'
  | 'deleteSessionAndRevokePlaybackGrants'
  | 'createLiveChannel'
  | 'createLiveChannelWithinCapacity'
  | 'getVersionedLiveChannel'
  | 'compareAndSetLiveChannel'
  | 'deleteLiveChannel'
  | 'putPersonalToken'
  | 'getPersonalToken'
  | 'usePersonalToken'
  | 'revokePersonalToken'
  | 'createUserIdentity'
  | 'getUserIdentity'
  | 'listUserIdentities'
  | 'compareAndSetUserIdentityPreservingOwner'
  | 'deleteUserIdentityPreservingOwner'
> &
  Pick<
    ClusterRepository,
    | 'createSegmentJob'
    | 'getVersionedSegmentJob'
    | 'completeSegmentJob'
    | 'cancelSegmentJob'
    | 'createNode'
    | 'ensureLocalNode'
    | 'setNodeDrain'
    | 'getNode'
    | 'getVersionedNode'
    | 'listNodeCertificates'
    | 'rotateNodeCertificate'
    | 'revokeNode'
    | 'removeNode'
    | 'createProviderBinding'
    | 'getVersionedProviderBinding'
    | 'compareAndSetProviderBinding'
    | 'listProviderBindings'
  > & {
    close(): void | Promise<void>;
  };

interface RepositoryPair {
  first: ConcurrencyRepository;
  second: ConcurrencyRepository;
  cleanup(): Promise<void>;
}

type RepositoryPairFactory = () => Promise<RepositoryPair>;

const baseTime = Date.parse('2026-07-15T00:00:00.000Z');
const at = (offsetMilliseconds: number): string =>
  new Date(baseTime + offsetMilliseconds).toISOString();

function session(id: string): RelaySession {
  return {
    id,
    name: `Session ${id}`,
    kind: 'vod',
    source: { providerId: 'provider-a', itemId: 'item-a' },
    durationSeconds: 60,
    profileId: 'profile-a',
    profileRevision: 1,
    platformMode: 'pc',
    state: 'active',
    pinned: false,
    reportActivity: false,
    viewers: 0,
    placementPolicy: 'local',
    placementLocked: false,
    outputUrls: { primary: `https://relay.example/play/${id}` },
    createdAt: at(0),
    updatedAt: at(0)
  };
}

function liveChannel(id: string): LiveChannel {
  return {
    id,
    name: `Live channel ${id}`,
    path: id,
    normalize: false,
    publisherState: 'offline',
    publishTokenHash: `hash-${id}`,
    rtmpUrl: `rtmp://relay.example/${id}`,
    srtUrl: `srt://relay.example:8890?streamid=publish:${id}`,
    whipUrl: `https://relay.example/${id}/whip`,
    createdAt: at(0)
  };
}

function liveSession(id: string, liveChannelId: string): RelaySession {
  return {
    id,
    name: `Session ${id}`,
    kind: 'live',
    liveChannelId,
    profileId: 'profile-live',
    profileRevision: 1,
    platformMode: 'pc',
    state: 'live',
    pinned: false,
    reportActivity: false,
    viewers: 0,
    placementPolicy: 'local',
    placementLocked: false,
    outputUrls: { primary: `https://relay.example/play/${id}/live.m3u8` },
    createdAt: at(0),
    updatedAt: at(0)
  };
}

function runningJob(id: string): SegmentJob {
  return {
    id,
    contentKey: `content/${id}`,
    sessionId: 'session-a',
    segmentIndex: 0,
    state: 'running',
    attempts: 1,
    ownerNodeId: 'worker-a',
    workerHistory: [],
    createdAt: at(0),
    updatedAt: at(0)
  };
}

function node(id: string): ClusterNode {
  return {
    id,
    name: `Node ${id}`,
    roles: ['source-worker'],
    region: 'local',
    publicUrl: `https://${id}.example`,
    state: 'online',
    capabilities: {
      encoders: ['libx264'],
      hardwareDevices: [],
      maxWorkers: 2,
      activeWorkers: 0,
      queuedWorkers: 0,
      cacheBytes: 0,
      cacheLimitBytes: 1_024,
      egressMbps: 0,
      providerIds: [],
      vodProducerVersion: 1
    },
    weight: 100,
    lastHeartbeatAt: at(0),
    createdAt: at(0),
    updatedAt: at(0)
  };
}

function certificate(
  nodeId: string,
  serialNumber: string,
  createdAt: string
): NodeCertificateState {
  return {
    nodeId,
    serialNumber,
    fingerprintSha256: `fingerprint-${serialNumber}`,
    expiresAt: new Date(Date.parse(createdAt) + 86_400_000).toISOString(),
    revokedAt: null,
    createdAt
  };
}

function provider(id: string): ProviderConnection {
  return {
    id,
    type: 'jellyfin',
    name: `Provider ${id}`,
    baseUrl: `https://${id}.example`,
    authMode: 'user_token',
    secretRef: `provider-binding:${id}`,
    capabilities: ['search'],
    healthy: true,
    createdAt: at(0),
    updatedAt: at(0)
  };
}

function binding(id: string, providerId: string): ProviderBinding {
  return {
    id,
    providerId,
    nodeId: 'worker-a',
    secretRef: `provider-binding:${id}`,
    reachable: true,
    state: 'healthy',
    deletionPending: false,
    validatedAt: at(0),
    createdAt: at(0),
    updatedAt: at(0)
  };
}

function personalToken(id: string): PersonalAccessToken {
  return {
    id,
    name: `Token ${id}`,
    tokenHash: `hash-${id}`,
    scopes: ['sessions:read'],
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: at(0)
  };
}

function userIdentity(id: string): UserIdentity {
  return {
    id,
    providerId: 'provider-a',
    providerUserId: `provider-user-${id}`,
    displayName: `Owner ${id}`,
    roles: ['owner'],
    allowedProfileIds: [],
    firstSeenAt: at(0),
    lastSeenAt: at(0)
  };
}

async function sqlitePair(): Promise<RepositoryPair> {
  const directory = await mkdtemp(join(tmpdir(), 'vrrelay-phase2-concurrency-'));
  const path = join(directory, 'state.sqlite');
  const first = new SqliteRepository(path);
  const second = new SqliteRepository(path);
  try {
    await first.migrate();
    await second.assertSchemaCurrent();
  } catch (error) {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    first,
    second,
    cleanup: async () => {
      first.close();
      second.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

const postgresUrl = process.env.VRRELAY_TEST_POSTGRES_URL;

async function postgresPair(): Promise<RepositoryPair> {
  const schema = `vrrelay_concurrency_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: postgresUrl! });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const configuration = {
    connectionString: postgresUrl!,
    options: `-c search_path=${schema}`
  };
  const first = new PostgresRepository(configuration);
  const second = new PostgresRepository(configuration);
  try {
    await first.migrate();
    await second.assertSchemaCurrent();
  } catch (error) {
    await Promise.allSettled([first.close(), second.close()]);
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    throw error;
  }
  return {
    first,
    second,
    cleanup: async () => {
      await Promise.all([first.close(), second.close()]);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  };
}

function repositoryConcurrencySuite(
  name: string,
  enabled: boolean,
  createPair: RepositoryPairFactory
): void {
  const suite = enabled ? describe : describe.skip;
  suite(name, () => {
    let pair: RepositoryPair | undefined;

    beforeEach(async () => {
      pair = await createPair();
    });

    afterEach(async () => {
      const current = pair;
      pair = undefined;
      await current?.cleanup();
    });

    const repositories = (): RepositoryPair => {
      if (!pair) throw new Error('Repository pair is not initialized');
      return pair;
    };

    it('serializes concurrent demotions so one assigned owner always remains', async () => {
      const { first, second } = repositories();
      const left = await first.createUserIdentity(userIdentity('owner-left'));
      const right = await first.createUserIdentity(userIdentity('owner-right'));
      const [leftResult, rightResult] = await Promise.all([
        first.compareAndSetUserIdentityPreservingOwner(
          { ...left.value, roles: ['admin'], lastSeenAt: at(1_000) },
          left.revision
        ),
        second.compareAndSetUserIdentityPreservingOwner(
          { ...right.value, roles: ['admin'], lastSeenAt: at(1_000) },
          right.revision
        )
      ]);

      expect([leftResult, rightResult].filter((result) => result.applied)).toHaveLength(1);
      expect([leftResult, rightResult].filter((result) => !result.applied)).toEqual([
        expect.objectContaining({ reason: 'dependency-conflict' })
      ]);
      const identities = await first.listUserIdentities();
      expect(identities.filter((identity) => identity.value.roles.includes('owner'))).toHaveLength(
        1
      );
    });

    it('serializes user deletion against creation of an owned live channel', async () => {
      const { first, second } = repositories();
      const target = await first.createUserIdentity(userIdentity('owner-delete-target'));
      await first.createUserIdentity(userIdentity('owner-delete-survivor'));
      const channel = {
        ...liveChannel('live-owned-during-delete'),
        ownerId: target.value.id
      };

      const [deleted, created] = await Promise.all([
        first.deleteUserIdentityPreservingOwner(target.value.id, target.revision),
        second.createLiveChannelWithinCapacity(channel, {
          maxTotal: 10,
          maxPerOwner: 10
        })
      ]);

      if (deleted.applied) {
        expect(created).toEqual({ created: false, reason: 'owner-not-found' });
        await expect(first.getUserIdentity(target.value.id)).resolves.toBeUndefined();
      } else {
        expect(deleted).toMatchObject({
          reason: 'dependency-conflict',
          dependencies: ['owned-live-channels']
        });
        expect(created).toMatchObject({ created: true });
        await expect(first.getUserIdentity(target.value.id)).resolves.toEqual(target);
      }
    });

    it('does not delete the last assigned owner', async () => {
      const { first } = repositories();
      const owner = await first.createUserIdentity(userIdentity('last-owner-delete'));

      await expect(
        first.deleteUserIdentityPreservingOwner(owner.value.id, owner.revision)
      ).resolves.toMatchObject({
        applied: false,
        reason: 'dependency-conflict',
        dependencies: ['assigned-owner']
      });
      await expect(first.getUserIdentity(owner.value.id)).resolves.toEqual(owner);
    });

    it('reports sessions and live channels owned by a user as deletion dependencies', async () => {
      const { first } = repositories();
      const identity = await first.createUserIdentity({
        ...userIdentity('resource-owner-delete'),
        roles: ['user']
      });
      await first.createProvider(provider('provider-a'));
      const ownedSession = {
        ...session('owned-session-delete'),
        ownerId: identity.value.id
      };
      await first.createSessionWithPlaybackGrant(ownedSession, {
        tokenHash: 'owned-session-delete-grant',
        sessionId: ownedSession.id,
        expiresAt: null,
        revokedAt: null,
        createdAt: ownedSession.createdAt
      });
      await first.createLiveChannelWithinCapacity(
        {
          ...liveChannel('owned-live-delete'),
          ownerId: identity.value.id
        },
        { maxTotal: 10, maxPerOwner: 10 }
      );

      await expect(
        first.deleteUserIdentityPreservingOwner(identity.value.id, identity.revision)
      ).resolves.toMatchObject({
        applied: false,
        reason: 'dependency-conflict',
        dependencies: ['owned-sessions', 'owned-live-channels']
      });
      await expect(first.getUserIdentity(identity.value.id)).resolves.toEqual(identity);
    });

    it('fences stale-user purge against a concurrent sign-in refresh', async () => {
      const { first, second } = repositories();
      const identity = await first.createUserIdentity({
        ...userIdentity('stale-user-refresh-race'),
        roles: ['user']
      });
      const [refreshed, deleted] = await Promise.all([
        first.compareAndSetUserIdentityPreservingOwner(
          { ...identity.value, lastSeenAt: at(2_000) },
          identity.revision
        ),
        second.deleteUserIdentityPreservingOwner(identity.value.id, identity.revision, at(1_000))
      ]);

      expect([refreshed.applied, deleted.applied].filter(Boolean)).toHaveLength(1);
      if (refreshed.applied) {
        expect(deleted).toMatchObject({ applied: false, reason: 'revision-conflict' });
        await expect(first.getUserIdentity(identity.value.id)).resolves.toEqual(refreshed.record);
      } else {
        expect(deleted).toMatchObject({ applied: true });
        expect(refreshed).toMatchObject({ applied: false, reason: 'not-found' });
        await expect(first.getUserIdentity(identity.value.id)).resolves.toBeUndefined();
      }
    });

    it('allows only one session CAS write from two stale snapshots', async () => {
      const { first, second } = repositories();
      const initial = session('session-cas');
      await first.createProvider(provider(initial.source!.providerId));
      await first.createSessionWithPlaybackGrant(initial, {
        tokenHash: 'session-cas-grant',
        sessionId: initial.id,
        expiresAt: null,
        revokedAt: null,
        createdAt: initial.createdAt
      });
      const leftSnapshot = (await first.getVersionedSession(initial.id))!;
      const rightSnapshot = (await second.getVersionedSession(initial.id))!;
      expect(rightSnapshot).toEqual(leftSnapshot);

      const leftValue: RelaySession = {
        ...leftSnapshot.value,
        pinned: true,
        updatedAt: at(1_000)
      };
      const rightValue: RelaySession = {
        ...rightSnapshot.value,
        state: 'stopped',
        updatedAt: at(2_000)
      };
      const [leftResult, rightResult] = await Promise.all([
        first.compareAndSetSession(leftValue, leftSnapshot.revision),
        second.compareAndSetSession(rightValue, rightSnapshot.revision)
      ]);

      expect([leftResult, rightResult].filter((result) => result.applied)).toHaveLength(1);
      const winnerRecord = leftResult.applied
        ? leftResult.record
        : rightResult.applied
          ? rightResult.record
          : undefined;
      const loser = leftResult.applied ? rightResult : leftResult;
      expect(winnerRecord).toBeDefined();
      expect(loser).toMatchObject({ applied: false, reason: 'revision-conflict' });
      await expect(second.getVersionedSession(initial.id)).resolves.toEqual(winnerRecord);
    });

    it('fences conditional session deletion against fresh playback activity', async () => {
      const { first, second } = repositories();
      const initial: RelaySession = {
        ...session('session-retention-race'),
        lastPlaybackActivityAt: at(0),
        deletionPending: false
      };
      await first.createProvider(provider(initial.source!.providerId));
      await first.createSessionWithPlaybackGrant(initial, {
        tokenHash: 'session-retention-race-grant',
        sessionId: initial.id,
        expiresAt: null,
        revokedAt: null,
        createdAt: initial.createdAt
      });
      const stale = (await first.getVersionedSession(initial.id))!;

      const [touched, deletion] = await Promise.all([
        first.touchSessionPlaybackActivity(initial.id, at(2_000), at(1_000)),
        second.beginSessionDeletion(initial.id, {
          observedAt: at(3_000),
          inactiveBefore: at(1_000),
          requireUnpinned: true
        })
      ]);

      if (deletion.applied) {
        expect(touched).toBe(false);
        await expect(first.getVersionedSession(initial.id)).resolves.toMatchObject({
          value: {
            state: 'stopped',
            deletionPending: true,
            lastPlaybackActivityAt: at(0)
          }
        });
        await expect(
          first.compareAndSetSession(
            { ...stale.value, pinned: true, updatedAt: at(4_000) },
            stale.revision
          )
        ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
        await expect(first.getPlaybackGrant('session-retention-race-grant')).resolves.toMatchObject(
          {
            revokedAt: at(3_000)
          }
        );
      } else {
        expect(touched).toBe(true);
        expect(deletion).toMatchObject({ reason: 'invalid-state' });
        await expect(first.getVersionedSession(initial.id)).resolves.toMatchObject({
          value: {
            state: 'active',
            deletionPending: false,
            lastPlaybackActivityAt: at(2_000)
          }
        });
        await expect(first.getPlaybackGrant('session-retention-race-grant')).resolves.toMatchObject(
          {
            revokedAt: null
          }
        );
      }
    });

    it('excludes pinned sessions from inactivity expiry', async () => {
      const { first } = repositories();
      const initial: RelaySession = {
        ...session('session-retention-pinned'),
        pinned: true,
        lastPlaybackActivityAt: at(0)
      };
      await first.createProvider(provider(initial.source!.providerId));
      await first.createSessionWithPlaybackGrant(initial, {
        tokenHash: 'session-retention-pinned-grant',
        sessionId: initial.id,
        expiresAt: null,
        revokedAt: null,
        createdAt: initial.createdAt
      });

      await expect(first.listInactiveSessions(at(1_000))).resolves.toEqual([]);
      await expect(
        first.beginSessionDeletion(initial.id, {
          observedAt: at(2_000),
          inactiveBefore: at(1_000),
          requireUnpinned: true
        })
      ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });
      await expect(first.getPlaybackGrant('session-retention-pinned-grant')).resolves.toMatchObject(
        {
          revokedAt: null
        }
      );
    });

    it('rejects VOD session identity changes at the repository boundary', async () => {
      const { first, second } = repositories();
      const initial: RelaySession = {
        ...session('session-identity'),
        source: {
          providerId: 'provider-identity',
          itemId: 'item-a',
          versionId: 'version-a',
          sourceFingerprint: 'fingerprint-a',
          audioTrackId: 'audio-a',
          subtitleTrackId: 'subtitle-a'
        }
      };
      await first.createProvider(provider(initial.source!.providerId));
      await expect(
        first.createSessionWithPlaybackGrant(initial, {
          tokenHash: 'session-identity-grant',
          sessionId: initial.id,
          expiresAt: null,
          revokedAt: null,
          createdAt: initial.createdAt
        })
      ).resolves.toMatchObject({ applied: true });
      const snapshot = (await second.getVersionedSession(initial.id))!;
      const mutations: Array<{
        name: string;
        mutate(value: RelaySession): RelaySession;
      }> = [
        { name: 'kind', mutate: (value) => ({ ...value, kind: 'live' }) },
        { name: 'source removal', mutate: (value) => ({ ...value, source: undefined }) },
        {
          name: 'provider',
          mutate: (value) => ({
            ...value,
            source: { ...value.source!, providerId: 'provider-other' }
          })
        },
        {
          name: 'item',
          mutate: (value) => ({
            ...value,
            source: { ...value.source!, itemId: 'item-other' }
          })
        },
        {
          name: 'version',
          mutate: (value) => ({
            ...value,
            source: { ...value.source!, versionId: 'version-other' }
          })
        },
        {
          name: 'fingerprint',
          mutate: (value) => ({
            ...value,
            source: { ...value.source!, sourceFingerprint: 'fingerprint-other' }
          })
        },
        {
          name: 'audio track',
          mutate: (value) => ({
            ...value,
            source: { ...value.source!, audioTrackId: 'audio-other' }
          })
        },
        {
          name: 'subtitle track',
          mutate: (value) => ({
            ...value,
            source: { ...value.source!, subtitleTrackId: 'subtitle-other' }
          })
        },
        {
          name: 'live channel',
          mutate: (value) => ({ ...value, liveChannelId: 'live-other' })
        },
        { name: 'profile', mutate: (value) => ({ ...value, profileId: 'profile-other' }) },
        {
          name: 'profile revision',
          mutate: (value) => ({ ...value, profileRevision: value.profileRevision + 1 })
        },
        { name: 'platform', mutate: (value) => ({ ...value, platformMode: 'quest' }) },
        {
          name: 'duration',
          mutate: (value) => ({ ...value, durationSeconds: value.durationSeconds! + 1 })
        },
        { name: 'creation time', mutate: (value) => ({ ...value, createdAt: at(1_000) }) }
      ];

      for (const mutation of mutations) {
        await expect(
          first.compareAndSetSession(mutation.mutate(snapshot.value), snapshot.revision),
          mutation.name
        ).resolves.toMatchObject({ applied: false, reason: 'invalid-state', current: snapshot });
        await expect(second.getVersionedSession(initial.id)).resolves.toEqual(snapshot);
      }

      const legal = await first.compareAndSetSession(
        { ...snapshot.value, pinned: true, state: 'stopped', updatedAt: at(2_000) },
        snapshot.revision
      );
      expect(legal).toMatchObject({ applied: true, record: { revision: 2 } });
      await expect(
        second.compareAndSetSession(
          {
            ...snapshot.value,
            source: { ...snapshot.value.source!, providerId: 'provider-stale' },
            updatedAt: at(3_000)
          },
          snapshot.revision
        )
      ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
    });

    it('rejects live-channel and source ownership changes for live sessions', async () => {
      const { first, second } = repositories();
      const channel = await first.createLiveChannel(liveChannel('live-session-identity'));
      const initial = liveSession('live-session-identity', channel.value.id);
      await expect(
        first.createSessionWithPlaybackGrant(
          initial,
          {
            tokenHash: 'live-session-identity-grant',
            sessionId: initial.id,
            expiresAt: null,
            revokedAt: null,
            createdAt: initial.createdAt
          },
          channel.revision
        )
      ).resolves.toMatchObject({ applied: true });
      const snapshot = (await second.getVersionedSession(initial.id))!;

      for (const candidate of [
        { ...snapshot.value, liveChannelId: 'live-other', updatedAt: at(1_000) },
        {
          ...snapshot.value,
          source: { providerId: 'provider-a', itemId: 'item-a' },
          updatedAt: at(1_000)
        }
      ])
        await expect(
          first.compareAndSetSession(candidate, snapshot.revision)
        ).resolves.toMatchObject({ applied: false, reason: 'invalid-state', current: snapshot });
      await expect(first.getVersionedSession(initial.id)).resolves.toEqual(snapshot);
    });

    it('serializes installation and owner live-channel capacity across connections', async () => {
      const { first, second } = repositories();
      const ownerId = 'live-owner-capacity';
      await first.createUserIdentity(userIdentity(ownerId));
      const channels = [
        { ...liveChannel('live-capacity-a'), ownerId },
        { ...liveChannel('live-capacity-b'), ownerId }
      ];
      const results = await Promise.all([
        first.createLiveChannelWithinCapacity(channels[0]!, {
          maxTotal: 2,
          maxPerOwner: 1
        }),
        second.createLiveChannelWithinCapacity(channels[1]!, {
          maxTotal: 2,
          maxPerOwner: 1
        })
      ]);

      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results.filter((result) => !result.created)).toEqual([
        { created: false, reason: 'owner-limit' }
      ]);

      const installationResults = await Promise.all([
        first.createLiveChannelWithinCapacity(liveChannel('live-installation-a'), {
          maxTotal: 2,
          maxPerOwner: 2
        }),
        second.createLiveChannelWithinCapacity(liveChannel('live-installation-b'), {
          maxTotal: 2,
          maxPerOwner: 2
        })
      ]);
      expect(installationResults.filter((result) => result.created)).toHaveLength(1);
      expect(installationResults.filter((result) => !result.created)).toEqual([
        { created: false, reason: 'installation-limit' }
      ]);
    });

    it('does not let a stale publisher poll resurrect a deleted live channel', async () => {
      const { first, second } = repositories();
      const channel = liveChannel('live-delete-poll');
      const created = await first.createLiveChannel(channel);
      const stalePoll = (await first.getVersionedLiveChannel(channel.id))!;

      await expect(second.deleteLiveChannel(channel.id, created.revision)).resolves.toMatchObject({
        applied: true,
        record: created
      });
      await expect(
        first.compareAndSetLiveChannel(
          {
            ...stalePoll.value,
            publisherState: 'online',
            publisherUpdatedAt: at(1_000)
          },
          stalePoll.revision
        )
      ).resolves.toMatchObject({ applied: false, reason: 'not-found' });
      await expect(second.getVersionedLiveChannel(channel.id)).resolves.toBeUndefined();
    });

    it('keeps live-session creation and channel deletion in one atomic invariant', async () => {
      const { first, second } = repositories();

      const deletedFirst = await first.createLiveChannel(liveChannel('live-delete-first'));
      await expect(
        second.deleteLiveChannel(deletedFirst.value.id, deletedFirst.revision)
      ).resolves.toMatchObject({ applied: true });
      const rejectedSession = liveSession('session-after-delete', deletedFirst.value.id);
      await expect(
        first.createSessionWithPlaybackGrant(
          rejectedSession,
          {
            tokenHash: 'grant-after-delete',
            sessionId: rejectedSession.id,
            expiresAt: null,
            revokedAt: null,
            createdAt: rejectedSession.createdAt
          },
          deletedFirst.revision
        )
      ).resolves.toMatchObject({ applied: false, reason: 'not-found' });
      await expect(first.getVersionedSession(rejectedSession.id)).resolves.toBeUndefined();

      const sessionFirst = await first.createLiveChannel(liveChannel('live-session-first'));
      const acceptedSession = liveSession('session-before-delete', sessionFirst.value.id);
      await expect(
        second.createSessionWithPlaybackGrant(
          acceptedSession,
          {
            tokenHash: 'grant-before-delete',
            sessionId: acceptedSession.id,
            expiresAt: null,
            revokedAt: null,
            createdAt: acceptedSession.createdAt
          },
          sessionFirst.revision
        )
      ).resolves.toMatchObject({ applied: true });
      await expect(
        first.deleteLiveChannel(sessionFirst.value.id, sessionFirst.revision)
      ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });
      await expect(first.getVersionedLiveChannel(sessionFirst.value.id)).resolves.toEqual(
        sessionFirst
      );
    });

    it('makes job completion and cancellation exclusive across stale snapshots', async () => {
      const { first, second } = repositories();
      const initial = runningJob('job-terminal');
      await first.createSegmentJob(initial);
      const completeSnapshot = (await first.getVersionedSegmentJob(initial.id))!;
      const cancelSnapshot = (await second.getVersionedSegmentJob(initial.id))!;
      expect(cancelSnapshot).toEqual(completeSnapshot);

      const completeValue: SegmentJob = {
        ...completeSnapshot.value,
        state: 'complete',
        completedAt: at(1_000),
        updatedAt: at(1_000)
      };
      const cancelValue: SegmentJob = {
        ...cancelSnapshot.value,
        state: 'cancelled',
        completedAt: at(2_000),
        updatedAt: at(2_000)
      };
      const [completeResult, cancelResult] = await Promise.all([
        first.completeSegmentJob(completeValue, completeSnapshot.revision),
        second.cancelSegmentJob(cancelValue, cancelSnapshot.revision)
      ]);

      expect([completeResult, cancelResult].filter((result) => result.applied)).toHaveLength(1);
      const winnerRecord = completeResult.applied
        ? completeResult.record
        : cancelResult.applied
          ? cancelResult.record
          : undefined;
      const loser = completeResult.applied ? cancelResult : completeResult;
      expect(winnerRecord).toBeDefined();
      expect(loser).toMatchObject({ applied: false, reason: 'revision-conflict' });
      const terminal = (await first.getVersionedSegmentJob(initial.id))!;
      expect(terminal).toEqual(winnerRecord);

      const reverseResult =
        terminal.value.state === 'complete'
          ? await second.cancelSegmentJob(
              {
                ...terminal.value,
                state: 'cancelled',
                completedAt: at(3_000),
                updatedAt: at(3_000)
              },
              terminal.revision
            )
          : await first.completeSegmentJob(
              {
                ...terminal.value,
                state: 'complete',
                completedAt: at(3_000),
                updatedAt: at(3_000)
              },
              terminal.revision
            );
      expect(reverseResult).toMatchObject({ applied: false, reason: 'invalid-state' });
      await expect(second.getVersionedSegmentJob(initial.id)).resolves.toEqual(terminal);
    });

    it.each(['complete', 'cancelled'] as const)(
      'does not let a stale missing-row create overwrite a %s job',
      async (terminalState) => {
        const { first, second } = repositories();
        const initial = runningJob(`job-create-${terminalState}`);
        await expect(first.getVersionedSegmentJob(initial.id)).resolves.toBeUndefined();
        await expect(second.getVersionedSegmentJob(initial.id)).resolves.toBeUndefined();

        await expect(first.createSegmentJob(initial)).resolves.toMatchObject({
          created: true,
          record: { revision: 1 }
        });
        const snapshot = (await second.getVersionedSegmentJob(initial.id))!;
        const terminalValue: SegmentJob = {
          ...snapshot.value,
          state: terminalState,
          completedAt: at(1_000),
          updatedAt: at(1_000)
        };
        const transition =
          terminalState === 'complete'
            ? await second.completeSegmentJob(terminalValue, snapshot.revision)
            : await second.cancelSegmentJob(terminalValue, snapshot.revision);
        expect(transition).toMatchObject({ applied: true, record: { revision: 2 } });

        const replay = await first.createSegmentJob({ ...initial, updatedAt: at(2_000) });
        expect(replay).toMatchObject({
          created: false,
          record: { revision: 2, value: { state: terminalState, completedAt: at(1_000) } }
        });
        await expect(first.getVersionedSegmentJob(initial.id)).resolves.toEqual(replay.record);
      }
    );

    it.each(['draining', 'revoked'] as const)(
      'preserves a node in %s state when local registration refreshes its configuration',
      async (protectedState) => {
        const { first, second } = repositories();
        const initial = node(`node-restart-${protectedState}`);
        await first.createNode(initial);
        const snapshot = (await second.getVersionedNode(initial.id))!;
        const transition =
          protectedState === 'draining'
            ? await second.setNodeDrain({
                nodeId: initial.id,
                expectedRevision: snapshot.revision,
                draining: true,
                updatedAt: at(1_000)
              })
            : await second.revokeNode({
                nodeId: initial.id,
                expectedRevision: snapshot.revision,
                revokedAt: at(1_000)
              });
        expect(transition).toMatchObject({
          applied: true,
          record: { value: { state: protectedState } }
        });

        const ensured = await first.ensureLocalNode({
          ...initial,
          name: 'Refreshed local node',
          publicUrl: 'https://refreshed.example',
          state: 'online',
          capabilities: { ...initial.capabilities, activeWorkers: 1 },
          createdAt: at(9_000),
          lastHeartbeatAt: at(9_000),
          updatedAt: at(9_000)
        });
        expect(ensured).toMatchObject({
          revision: 3,
          value: {
            name: 'Refreshed local node',
            publicUrl: 'https://refreshed.example',
            state: protectedState,
            createdAt: initial.createdAt,
            capabilities: { activeWorkers: 1 }
          }
        });
        await expect(second.getVersionedNode(initial.id)).resolves.toEqual(ensured);
      }
    );

    it('creates a node and initial certificate atomically', async () => {
      const { first, second } = repositories();
      const firstNode = node('node-certificate-owner');
      await first.createNode(firstNode, certificate(firstNode.id, 'shared-serial', at(0)));

      const conflictingNode = node('node-certificate-conflict');
      await expect(
        second.createNode(
          conflictingNode,
          certificate(conflictingNode.id, 'shared-serial', at(1_000))
        )
      ).rejects.toThrow();
      await expect(first.getNode(conflictingNode.id)).resolves.toBeUndefined();
      await expect(first.listNodeCertificates(conflictingNode.id)).resolves.toEqual([]);
      await expect(second.listNodeCertificates(firstNode.id)).resolves.toEqual([
        expect.objectContaining({ nodeId: firstNode.id, serialNumber: 'shared-serial' })
      ]);
    });

    it('rolls back certificate rotation when another node owns the serial', async () => {
      const { first, second } = repositories();
      const owner = node('node-certificate-serial-owner');
      const target = node('node-certificate-serial-target');
      const ownerCertificate = certificate(owner.id, 'serial-collision', at(0));
      const targetCertificate = certificate(target.id, 'serial-target', at(0));
      await first.createNode(owner, ownerCertificate);
      const targetRecord = await first.createNode(target, targetCertificate);
      const ownerCertificatesBefore = await first.listNodeCertificates(owner.id);
      const targetCertificatesBefore = await first.listNodeCertificates(target.id);

      await expect(
        second.rotateNodeCertificate({
          nodeId: target.id,
          expectedRevision: targetRecord.revision,
          certificate: certificate(target.id, ownerCertificate.serialNumber, at(1_000)),
          updatedAt: at(1_000)
        })
      ).rejects.toThrow();

      await expect(first.getVersionedNode(target.id)).resolves.toEqual(targetRecord);
      await expect(second.listNodeCertificates(owner.id)).resolves.toEqual(ownerCertificatesBefore);
      await expect(second.listNodeCertificates(target.id)).resolves.toEqual(
        targetCertificatesBefore
      );
      expect(ownerCertificatesBefore).toEqual([
        expect.objectContaining({
          nodeId: owner.id,
          serialNumber: 'serial-collision',
          revokedAt: null
        })
      ]);
      expect(targetCertificatesBefore).toEqual([
        expect.objectContaining({
          nodeId: target.id,
          serialNumber: 'serial-target',
          revokedAt: null
        })
      ]);
    });

    it('keeps provider binding ownership immutable while preserving revision semantics', async () => {
      const { first, second } = repositories();
      const initialProvider = provider('provider-owner');
      const initialBinding = binding('binding-owner', initialProvider.id);
      await first.createNode(node(initialBinding.nodeId));
      await expect(
        first.createProviderBinding(initialProvider, initialBinding, null)
      ).resolves.toMatchObject({ applied: true, binding: { revision: 1 } });
      const snapshot = (await second.getVersionedProviderBinding(initialBinding.id))!;

      for (const candidate of [
        { ...snapshot.value, providerId: 'provider-other', updatedAt: at(1_000) },
        { ...snapshot.value, nodeId: 'worker-other', updatedAt: at(1_000) },
        { ...snapshot.value, secretRef: 'provider-binding:other', updatedAt: at(1_000) }
      ]) {
        await expect(
          first.compareAndSetProviderBinding(candidate, snapshot.revision, ['healthy'])
        ).resolves.toMatchObject({
          applied: false,
          reason: 'invalid-state',
          current: snapshot
        });
      }

      const legitimate = await first.compareAndSetProviderBinding(
        { ...snapshot.value, state: 'degraded', updatedAt: at(2_000) },
        snapshot.revision,
        ['healthy']
      );
      expect(legitimate).toMatchObject({ applied: true, record: { revision: 2 } });
      await expect(
        second.compareAndSetProviderBinding(
          { ...snapshot.value, nodeId: 'worker-other', updatedAt: at(3_000) },
          snapshot.revision
        )
      ).resolves.toMatchObject({ applied: false, reason: 'revision-conflict' });
      await expect(first.listProviderBindings(initialProvider.id)).resolves.toEqual([
        expect.objectContaining({
          id: initialBinding.id,
          providerId: initialProvider.id,
          nodeId: initialBinding.nodeId,
          secretRef: initialBinding.secretRef,
          state: 'degraded'
        })
      ]);
      await expect(second.listProviderBindings('provider-other')).resolves.toEqual([]);
    });

    it('makes provider deletion terminal against stale validation and new VOD work', async () => {
      const { first, second } = repositories();
      const initial = provider('provider-delete-terminal');
      const created = await first.createProvider(initial);
      const stale = (await second.getVersionedProvider(initial.id))!;
      expect(stale).toEqual(created);

      const deleting = await first.beginProviderDeletion(initial.id);
      expect(deleting).toMatchObject({ applied: true, record: { revision: 2 } });
      if (!deleting.applied) throw new Error('Provider deletion did not begin');
      await expect(second.getVersionedProvider(initial.id)).resolves.toBeUndefined();
      await expect(
        second.compareAndSetProvider(
          { ...stale.value, healthy: false, updatedAt: at(1_000) },
          stale.revision
        )
      ).resolves.toMatchObject({
        applied: false,
        reason: 'revision-conflict',
        current: { revision: deleting.record.revision }
      });

      const rejected = session('provider-delete-terminal-session');
      rejected.source = { providerId: initial.id, itemId: 'item-a' };
      await expect(
        second.createSessionWithPlaybackGrant(rejected, {
          tokenHash: 'provider-delete-terminal-grant',
          sessionId: rejected.id,
          expiresAt: null,
          revokedAt: null,
          createdAt: rejected.createdAt
        })
      ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });
      await expect(
        first.finalizeProviderDeletion(initial.id, deleting.record.revision)
      ).resolves.toMatchObject({ applied: true, deleted: deleting.record });
      await expect(first.getVersionedProvider(initial.id)).resolves.toBeUndefined();
    });

    it('does not let provider deletion cross an existing VOD dependency', async () => {
      const { first, second } = repositories();
      const initial = provider('provider-session-dependency');
      await first.createProvider(initial);
      const dependent = session('provider-dependent-session');
      dependent.source = { providerId: initial.id, itemId: 'item-a' };
      await expect(
        second.createSessionWithPlaybackGrant(dependent, {
          tokenHash: 'provider-dependent-session-grant',
          sessionId: dependent.id,
          expiresAt: null,
          revokedAt: null,
          createdAt: dependent.createdAt
        })
      ).resolves.toMatchObject({ applied: true });
      await expect(first.beginProviderDeletion(initial.id)).resolves.toMatchObject({
        applied: false,
        reason: 'dependency-conflict',
        dependencies: [`session:${dependent.id}`]
      });
      await expect(first.getVersionedProvider(initial.id)).resolves.toMatchObject({ revision: 1 });
    });

    it('serializes revoked node removal against provider-binding creation', async () => {
      const { first, second } = repositories();

      const bindingFirstNode = node('worker-binding-first');
      const bindingFirstCreated = await first.createNode(bindingFirstNode);
      const bindingFirstProvider = provider('provider-binding-first');
      const bindingFirst = {
        ...binding('binding-before-removal', bindingFirstProvider.id),
        nodeId: bindingFirstNode.id
      };
      await expect(
        second.createProviderBinding(bindingFirstProvider, bindingFirst, null)
      ).resolves.toMatchObject({ applied: true });
      const bindingFirstRevoked = await first.revokeNode({
        nodeId: bindingFirstNode.id,
        expectedRevision: bindingFirstCreated.revision,
        revokedAt: at(1_000)
      });
      expect(bindingFirstRevoked).toMatchObject({ applied: true });
      if (!bindingFirstRevoked.applied) throw new Error('Node revocation did not apply');
      await expect(
        first.removeNode(bindingFirstNode.id, bindingFirstRevoked.record.revision)
      ).resolves.toMatchObject({
        applied: false,
        reason: 'dependency-conflict',
        dependencies: [`binding:${bindingFirst.id}`]
      });

      const removalFirstNode = node('worker-removal-first');
      const removalFirstCreated = await first.createNode(removalFirstNode);
      const removalFirstRevoked = await second.revokeNode({
        nodeId: removalFirstNode.id,
        expectedRevision: removalFirstCreated.revision,
        revokedAt: at(2_000)
      });
      expect(removalFirstRevoked).toMatchObject({ applied: true });
      if (!removalFirstRevoked.applied) throw new Error('Node revocation did not apply');
      await expect(
        first.removeNode(removalFirstNode.id, removalFirstRevoked.record.revision)
      ).resolves.toMatchObject({ applied: true });
      const orphanProvider = provider('provider-after-node-removal');
      const orphanBinding = {
        ...binding('binding-after-removal', orphanProvider.id),
        nodeId: removalFirstNode.id
      };
      await expect(
        second.createProviderBinding(orphanProvider, orphanBinding, null)
      ).resolves.toMatchObject({ applied: false, reason: 'node-unavailable' });
      await expect(second.getVersionedProvider(orphanProvider.id)).resolves.toBeUndefined();
      await expect(second.getVersionedProviderBinding(orphanBinding.id)).resolves.toBeUndefined();
    });

    it.each(['rotation-first', 'revocation-first'] as const)(
      'keeps node revocation terminal with the %s stale-write schedule',
      async (schedule) => {
        const { first, second } = repositories();
        const initial = node(`node-${schedule}`);
        await first.createNode(initial, certificate(initial.id, 'serial-old', at(0)));
        const rotationSnapshot = (await first.getVersionedNode(initial.id))!;
        const revocationSnapshot = (await second.getVersionedNode(initial.id))!;
        expect(revocationSnapshot).toEqual(rotationSnapshot);
        const replacement = certificate(initial.id, 'serial-new', at(1_000));

        const rotate = () =>
          first.rotateNodeCertificate({
            nodeId: initial.id,
            expectedRevision: rotationSnapshot.revision,
            certificate: replacement,
            updatedAt: at(1_000)
          });
        const revoke = () =>
          second.revokeNode({
            nodeId: initial.id,
            expectedRevision: revocationSnapshot.revision,
            revokedAt: at(2_000)
          });

        if (schedule === 'rotation-first') {
          await expect(rotate()).resolves.toMatchObject({ applied: true });
          await expect(revoke()).resolves.toMatchObject({
            applied: false,
            reason: 'revision-conflict'
          });
          const fresh = (await second.getVersionedNode(initial.id))!;
          await expect(
            second.revokeNode({
              nodeId: initial.id,
              expectedRevision: fresh.revision,
              revokedAt: at(3_000)
            })
          ).resolves.toMatchObject({ applied: true, record: { value: { state: 'revoked' } } });
        } else {
          await expect(revoke()).resolves.toMatchObject({ applied: true });
          await expect(rotate()).resolves.toMatchObject({
            applied: false,
            reason: 'revision-conflict'
          });
          const fresh = (await first.getVersionedNode(initial.id))!;
          await expect(
            first.rotateNodeCertificate({
              nodeId: initial.id,
              expectedRevision: fresh.revision,
              certificate: replacement,
              updatedAt: at(3_000)
            })
          ).resolves.toMatchObject({ applied: false, reason: 'invalid-state' });
        }

        await expect(first.getNode(initial.id)).resolves.toMatchObject({ state: 'revoked' });
        const certificates = await second.listNodeCertificates(initial.id);
        expect(certificates.every((item) => item.revokedAt !== null)).toBe(true);
        expect(certificates.some((item) => item.revokedAt === null)).toBe(false);
        if (schedule === 'revocation-first')
          expect(certificates.map((item) => item.serialNumber)).not.toContain('serial-new');
      }
    );

    it.each(['use-first', 'revoke-first'] as const)(
      'keeps personal-token revocation terminal with the %s stale-write schedule',
      async (schedule) => {
        const { first, second } = repositories();
        const initial = personalToken(`token-${schedule}`);
        await first.putPersonalToken(initial);
        const firstSnapshot = await first.getPersonalToken(initial.tokenHash);
        const secondSnapshot = await second.getPersonalToken(initial.tokenHash);
        expect(firstSnapshot).toMatchObject({ lastUsedAt: null, revokedAt: null });
        expect(secondSnapshot).toEqual(firstSnapshot);
        const use = () =>
          first.usePersonalToken({
            tokenHash: initial.tokenHash,
            usedAt: at(1_000),
            touchBefore: at(-59_000)
          });
        const revoke = () => second.revokePersonalToken(initial.id, at(2_000));

        if (schedule === 'use-first') {
          await expect(use()).resolves.toMatchObject({ lastUsedAt: at(1_000), revokedAt: null });
          await revoke();
        } else {
          await revoke();
          await expect(use()).resolves.toBeUndefined();
        }

        await expect(first.getPersonalToken(initial.tokenHash)).resolves.toMatchObject({
          lastUsedAt: schedule === 'use-first' ? at(1_000) : null,
          revokedAt: at(2_000)
        });
        await expect(
          second.usePersonalToken({
            tokenHash: initial.tokenHash,
            usedAt: at(3_000),
            touchBefore: at(-57_000)
          })
        ).resolves.toBeUndefined();
        await expect(second.getPersonalToken(initial.tokenHash)).resolves.toMatchObject({
          revokedAt: at(2_000)
        });
      }
    );
  });
}

repositoryConcurrencySuite('SQLite repository connection concurrency', true, sqlitePair);
repositoryConcurrencySuite(
  'PostgreSQL repository connection concurrency',
  Boolean(postgresUrl),
  postgresPair
);
