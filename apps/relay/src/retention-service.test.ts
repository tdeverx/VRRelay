// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteRepository } from '@vrrelay/adapters';
import { AuditService, type SessionService } from '@vrrelay/application';
import type { RelaySession, UserIdentity } from '@vrrelay/domain';
import { AuthService } from './auth.js';
import { RetentionService } from './retention-service.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const now = Date.parse('2026-07-26T12:00:00.000Z');
const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();

function session(id: string, lastPlaybackActivityAt: string, pinned = false): RelaySession {
  return {
    id,
    name: id,
    kind: 'vod',
    source: { providerId: 'provider-retention', itemId: `item-${id}` },
    durationSeconds: 60,
    profileId: 'profile-retention',
    profileRevision: 1,
    platformMode: 'pc',
    state: 'active',
    pinned,
    reportActivity: false,
    viewers: 0,
    placementPolicy: 'local',
    placementLocked: false,
    lastPlaybackActivityAt,
    deletionPending: false,
    outputUrls: { primary: `https://relay.example/play/${id}/index.m3u8` },
    createdAt: at(-90 * 24 * 60 * 60 * 1_000),
    updatedAt: lastPlaybackActivityAt
  };
}

function user(id: string, lastSeenAt: string, roles: UserIdentity['roles']): UserIdentity {
  return {
    id,
    providerId: 'provider-retention',
    providerUserId: `provider-${id}`,
    displayName: id,
    roles,
    allowedProfileIds: ['profile-retention'],
    defaultProfileId: 'profile-retention',
    firstSeenAt: at(-180 * 24 * 60 * 60 * 1_000),
    lastSeenAt
  };
}

describe('retention service', () => {
  it('defaults to disabled retention', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-retention-defaults-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const retention = new RetentionService(
      repository,
      {} as SessionService,
      new AuthService(repository),
      new AuditService(repository)
    );

    await expect(retention.configuration()).resolves.toEqual({
      sessionInactivityDeletionHours: null,
      staleUserPurgeDays: null
    });
    await expect(retention.sweep(now)).resolves.toEqual({
      sessionsDeleted: 0,
      usersDeleted: 0,
      failures: 0
    });
    await retention.configure({
      sessionInactivityDeletionHours: 12,
      staleUserPurgeDays: 45
    });
    repository.close();
    const reopened = new SqliteRepository(join(directory, 'state.sqlite3'));
    await reopened.assertSchemaCurrent();
    const restored = new RetentionService(
      reopened,
      {} as SessionService,
      new AuthService(reopened),
      new AuditService(reopened)
    );
    await expect(restored.configuration()).resolves.toEqual({
      sessionInactivityDeletionHours: 12,
      staleUserPurgeDays: 45
    });
    reopened.close();
  });

  it('deletes only idle unpinned sessions and stale ordinary users and audits each purge', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-retention-sweep-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const providerTime = at(-180 * 24 * 60 * 60 * 1_000);
    await repository.createProvider({
      id: 'provider-retention',
      type: 'jellyfin',
      name: 'Retention provider',
      baseUrl: 'https://media.example',
      authMode: 'delegated',
      secretRef: 'provider:retention',
      capabilities: ['search'],
      healthy: true,
      createdAt: providerTime,
      updatedAt: providerTime
    });
    const idle = session('idle-session', at(-2 * 60 * 60 * 1_000));
    const pinned = session('pinned-session', at(-2 * 60 * 60 * 1_000), true);
    const recent = session('recent-session', at(-30 * 60 * 1_000));
    for (const value of [idle, pinned, recent])
      await repository.createSessionWithPlaybackGrant(value, {
        tokenHash: `grant-${value.id}`,
        sessionId: value.id,
        expiresAt: null,
        revokedAt: null,
        createdAt: value.createdAt
      });
    const staleUser = await repository.createUserIdentity(
      user('stale-user', at(-45 * 24 * 60 * 60 * 1_000), ['user'])
    );
    await repository.createUserIdentity(
      user('active-stale-user', at(-45 * 24 * 60 * 60 * 1_000), ['user'])
    );
    await repository.createUserIdentity(
      user('stale-admin', at(-45 * 24 * 60 * 60 * 1_000), ['admin'])
    );
    await repository.createUserIdentity(
      user('recent-user', at(-5 * 24 * 60 * 60 * 1_000), ['user'])
    );

    const sessions = {
      deleteIfInactive: async (id: string, inactiveBefore: string) => {
        const begun = await repository.beginSessionDeletion(id, {
          observedAt: at(0),
          inactiveBefore,
          requireUnpinned: true
        });
        if (!begun.applied) return false;
        await repository.deleteSessionAndRevokePlaybackGrants(id, at(0));
        return true;
      }
    } as unknown as SessionService;
    const auth = new AuthService(repository);
    vi.spyOn(auth, 'hasActiveBrowserSession').mockImplementation(
      (identityId) => identityId === 'active-stale-user'
    );
    const audit = new AuditService(repository);
    const retention = new RetentionService(repository, sessions, auth, audit);
    await retention.configure({
      sessionInactivityDeletionHours: 1,
      staleUserPurgeDays: 30
    });

    await expect(retention.sweep(now)).resolves.toEqual({
      sessionsDeleted: 1,
      usersDeleted: 1,
      failures: 0
    });
    await expect(repository.getSession(idle.id)).resolves.toBeUndefined();
    await expect(repository.getSession(pinned.id)).resolves.toEqual(pinned);
    await expect(repository.getSession(recent.id)).resolves.toEqual(recent);
    await expect(repository.getUserIdentity(staleUser.value.id)).resolves.toBeUndefined();
    await expect(repository.getUserIdentity('active-stale-user')).resolves.toBeDefined();
    await expect(repository.getUserIdentity('stale-admin')).resolves.toBeDefined();
    await expect(repository.getUserIdentity('recent-user')).resolves.toBeDefined();
    await expect(repository.listAuditEvents()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'session.expire', outcome: 'success' }),
        expect.objectContaining({ action: 'user.purge', outcome: 'success' })
      ])
    );
    repository.close();
  });

  it('retries deletion-pending sessions on every sweep without requiring a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-retention-pending-retry-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const providerTime = at(-180 * 24 * 60 * 60 * 1_000);
    await repository.createProvider({
      id: 'provider-retention',
      type: 'jellyfin',
      name: 'Retention provider',
      baseUrl: 'https://media.example',
      authMode: 'delegated',
      secretRef: 'provider:retention',
      capabilities: ['search'],
      healthy: true,
      createdAt: providerTime,
      updatedAt: providerTime
    });
    const pending = session('pending-session', at(-2 * 60 * 60 * 1_000));
    await repository.createSessionWithPlaybackGrant(pending, {
      tokenHash: 'grant-pending-session',
      sessionId: pending.id,
      expiresAt: null,
      revokedAt: null,
      createdAt: pending.createdAt
    });
    await repository.beginSessionDeletion(pending.id, { observedAt: at(0) });
    let attempts = 0;
    const sessions = {
      delete: async (id: string) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient producer cleanup failure');
        await repository.deleteSessionAndRevokePlaybackGrants(id, at(0));
      }
    } as unknown as SessionService;
    const retention = new RetentionService(
      repository,
      sessions,
      new AuthService(repository),
      new AuditService(repository)
    );

    await expect(retention.sweep(now)).resolves.toEqual({
      sessionsDeleted: 0,
      usersDeleted: 0,
      failures: 1
    });
    await expect(repository.listSessionDeletionPending()).resolves.toHaveLength(1);
    await expect(retention.sweep(now)).resolves.toEqual({
      sessionsDeleted: 1,
      usersDeleted: 0,
      failures: 0
    });
    await expect(repository.getSession(pending.id)).resolves.toBeUndefined();
    repository.close();
  });

  it('does not let protected stale users starve later purgeable users', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-retention-user-starvation-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    for (let index = 0; index < 105; index += 1)
      await repository.createUserIdentity(
        user(
          `stale-admin-${index.toString().padStart(3, '0')}`,
          at((-60 * 24 * 60 * 60 + index) * 1_000),
          ['admin']
        )
      );
    const purgeable = await repository.createUserIdentity(
      user('purgeable-after-protected-page', at(-45 * 24 * 60 * 60 * 1_000), ['user'])
    );
    const retention = new RetentionService(
      repository,
      {} as SessionService,
      new AuthService(repository),
      new AuditService(repository)
    );
    await retention.configure({
      sessionInactivityDeletionHours: null,
      staleUserPurgeDays: 30
    });

    await expect(retention.sweep(now)).resolves.toEqual({
      sessionsDeleted: 0,
      usersDeleted: 1,
      failures: 0
    });
    await expect(repository.getUserIdentity(purgeable.value.id)).resolves.toBeUndefined();
    repository.close();
  });
});
