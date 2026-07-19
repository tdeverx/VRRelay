// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { SqliteRepository } from '@vrrelay/adapters';
import { AuthService } from './auth.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function bearer(token: string): FastifyRequest {
  return {
    cookies: {},
    headers: { authorization: `Bearer ${token}` }
  } as FastifyRequest;
}

describe('personal access tokens', () => {
  it('returns the complete public record, records use, enforces scopes, and revokes access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-auth-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const auth = new AuthService(repository);

    const created = await auth.createPersonalToken('Test client', ['sessions:read'], null);
    expect(created).toMatchObject({
      name: 'Test client',
      scopes: ['sessions:read'],
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null
    });
    expect(created.token).toMatch(/^vrr_/);
    expect(JSON.stringify(created)).not.toContain('tokenHash');

    await expect(
      auth.authenticate(bearer(created.token), ['sessions:read'])
    ).resolves.toMatchObject({
      kind: 'personal_token'
    });
    await expect(auth.authenticate(bearer(created.token), ['sessions:control'])).rejects.toThrow(
      'required scope'
    );
    expect((await auth.listPersonalTokens())[0]?.lastUsedAt).not.toBeNull();

    await auth.revokePersonalToken(created.id);
    await expect(auth.authenticate(bearer(created.token), ['sessions:read'])).rejects.toThrow(
      'Authentication is required'
    );
    repository.close();
  });

  it('rejects authentication when revocation wins the token-use race', async () => {
    class RevokeBeforeUseRepository extends SqliteRepository {
      revokeBeforeNextUse: string | undefined;

      override async usePersonalToken(update: Parameters<SqliteRepository['usePersonalToken']>[0]) {
        const id = this.revokeBeforeNextUse;
        if (id) {
          this.revokeBeforeNextUse = undefined;
          await super.revokePersonalToken(id, new Date().toISOString());
        }
        return super.usePersonalToken(update);
      }
    }

    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-auth-race-'));
    directories.push(directory);
    const repository = new RevokeBeforeUseRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const auth = new AuthService(repository);
    const created = await auth.createPersonalToken('Racing client', ['sessions:read'], null);
    repository.revokeBeforeNextUse = created.id;

    await expect(auth.authenticate(bearer(created.token), ['sessions:read'])).rejects.toThrow(
      'Authentication is required'
    );
    expect((await auth.listPersonalTokens())[0]).toMatchObject({
      id: created.id,
      lastUsedAt: null,
      revokedAt: expect.any(String)
    });
    repository.close();
  });
});

describe('first-run administrator initialization', () => {
  it('allows exactly one password to win across concurrent controller connections', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-auth-setup-race-'));
    directories.push(directory);
    const path = join(directory, 'state.sqlite3');
    const firstRepository = new SqliteRepository(path);
    await firstRepository.migrate();
    const secondRepository = new SqliteRepository(path);
    await secondRepository.assertSchemaCurrent();
    const first = new AuthService(firstRepository);
    const second = new AuthService(secondRepository);
    const passwords = ['first-password', 'second-password'] as const;

    const results = await Promise.allSettled([
      first.initialize(passwords[0]),
      second.initialize(passwords[1])
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const winner = results.findIndex(({ status }) => status === 'fulfilled');
    const loser = winner === 0 ? 1 : 0;
    await expect(first.login(passwords[winner]!)).resolves.toMatchObject({
      token: expect.any(String)
    });
    await expect(first.login(passwords[loser]!)).rejects.toThrow('Invalid recovery password');
    secondRepository.close();
    firstRepository.close();
  });
});

describe('unified user grants', () => {
  it('updates roles with revision protection and preserves the last assigned owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-auth-users-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const now = new Date().toISOString();
    const created = await repository.createUserIdentity({
      id: 'identity-1',
      providerId: 'provider-1',
      providerUserId: 'jellyfin-1',
      displayName: 'Alice',
      roles: ['user'],
      allowedProfileIds: ['profile-1'],
      defaultProfileId: 'profile-1',
      firstSeenAt: now,
      lastSeenAt: now
    });
    const auth = new AuthService(repository);
    const promoted = await auth.updateUser(created.value.id, created.revision, {
      roles: ['owner'],
      allowedProfileIds: ['profile-1'],
      defaultProfileId: 'profile-1'
    });
    expect(promoted.value.roles).toEqual(['owner']);
    await expect(
      auth.updateUser(promoted.value.id, promoted.revision, {
        roles: ['admin'],
        allowedProfileIds: ['profile-1'],
        defaultProfileId: 'profile-1'
      })
    ).rejects.toThrow('last assigned owner');
    await expect(
      auth.updateUser(promoted.value.id, created.revision, {
        roles: ['owner'],
        allowedProfileIds: ['profile-1'],
        defaultProfileId: 'profile-1'
      })
    ).rejects.toThrow('changed by another request');
    repository.close();
  });
});
