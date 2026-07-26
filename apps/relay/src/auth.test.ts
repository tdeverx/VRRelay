// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { MemorySecretStore, SqliteRepository } from '@vrrelay/adapters';
import { hashToken, type ProviderService } from '@vrrelay/application';
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
  } as unknown as FastifyRequest;
}

function browser(token: string): FastifyRequest {
  return {
    cookies: { vrrelay_session: token },
    headers: {}
  } as unknown as FastifyRequest;
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

  it('rejects self-deletion and revokes every browser session when another owner deletes a user', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-auth-user-delete-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const secrets = new MemorySecretStore();
    const providers = {
      authenticateUser: async () => ({
        accessToken: 'browser-access-token',
        userId: 'jellyfin-user-delete',
        username: 'Alice'
      })
    } as unknown as ProviderService;
    const auth = new AuthService(repository, secrets, providers);
    await auth.configure({
      providerId: 'provider-delete',
      defaultProfileId: 'profile-a',
      allowedProfileIds: ['profile-a'],
      reportPlaybackActivity: true
    });
    const first = await auth.login({
      method: 'jellyfin',
      username: 'alice',
      password: 'password'
    });
    const second = await auth.login({
      method: 'jellyfin',
      username: 'alice',
      password: 'password'
    });
    const record = (await auth.listUsers())[0]!;

    await expect(
      auth.deleteUser(record.value.id, record.revision, {
        requesterId: record.value.id
      })
    ).rejects.toThrow('cannot delete your own user');
    await expect(auth.authenticate(browser(first.token))).resolves.toMatchObject({
      id: record.value.id
    });

    await expect(
      auth.deleteUser(record.value.id, record.revision, {
        requesterId: 'different-owner'
      })
    ).resolves.toBe(true);
    await expect(auth.authenticate(browser(first.token))).rejects.toThrow(
      'Authentication is required'
    );
    await expect(auth.authenticate(browser(second.token))).rejects.toThrow(
      'Authentication is required'
    );
    await expect(repository.getUserIdentity(record.value.id)).resolves.toBeUndefined();
    await expect(secrets.get(`browser-session:${hashToken(first.token)}`)).rejects.toThrow(
      'Secret not found'
    );
    await expect(secrets.get(`browser-session:${hashToken(second.token)}`)).rejects.toThrow(
      'Secret not found'
    );
    repository.close();
  });

  it('recreates the identity when stale purge deletes it during a successful login refresh', async () => {
    class LoginRefreshBarrierRepository extends SqliteRepository {
      readonly refreshEntered = Promise.withResolvers<void>();
      readonly continueRefresh = Promise.withResolvers<void>();
      blockRefresh = true;

      override async compareAndSetUserIdentity(
        identity: Parameters<SqliteRepository['compareAndSetUserIdentity']>[0],
        expectedRevision: number
      ) {
        if (this.blockRefresh) {
          this.blockRefresh = false;
          this.refreshEntered.resolve();
          await this.continueRefresh.promise;
        }
        return super.compareAndSetUserIdentity(identity, expectedRevision);
      }
    }

    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-auth-stale-purge-race-'));
    directories.push(directory);
    const repository = new LoginRefreshBarrierRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const providerId = 'provider-login-purge-race';
    const providerUserId = 'provider-user-login-purge-race';
    const identityId = hashToken(`${providerId}\0${providerUserId}`);
    const oldLastSeenAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1_000).toISOString();
    const stale = await repository.createUserIdentity({
      id: identityId,
      providerId,
      providerUserId,
      displayName: 'Alice',
      roles: ['user'],
      allowedProfileIds: ['profile-a'],
      defaultProfileId: 'profile-a',
      firstSeenAt: oldLastSeenAt,
      lastSeenAt: oldLastSeenAt
    });
    const secrets = new MemorySecretStore();
    const providers = {
      authenticateUser: async () => ({
        accessToken: 'fresh-browser-access-token',
        userId: providerUserId,
        username: 'Alice'
      })
    } as unknown as ProviderService;
    const auth = new AuthService(repository, secrets, providers);
    await auth.configure({
      providerId,
      defaultProfileId: 'profile-a',
      allowedProfileIds: ['profile-a'],
      reportPlaybackActivity: true
    });

    const pendingLogin = auth.login({
      method: 'jellyfin',
      username: 'alice',
      password: 'password'
    });
    await repository.refreshEntered.promise;
    const lastSeenBefore = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    await expect(
      repository.deleteUserIdentityPreservingOwner(stale.value.id, stale.revision, lastSeenBefore)
    ).resolves.toMatchObject({ applied: true });
    repository.continueRefresh.resolve();

    const loggedIn = await pendingLogin;
    await expect(auth.authenticate(browser(loggedIn.token))).resolves.toMatchObject({
      id: identityId
    });
    await expect(repository.getUserIdentity(identityId)).resolves.toMatchObject({
      value: { id: identityId, lastSeenAt: expect.any(String) }
    });
    expect((await repository.getUserIdentity(identityId))!.value.lastSeenAt > lastSeenBefore).toBe(
      true
    );
    repository.close();
  });

  it('serializes manual deletion through browser-session installation', async () => {
    class LoginSecretBarrierStore extends MemorySecretStore {
      readonly putEntered = Promise.withResolvers<void>();
      readonly continuePut = Promise.withResolvers<void>();

      override async put(ref: string, value: string): Promise<void> {
        this.putEntered.resolve();
        await this.continuePut.promise;
        await super.put(ref, value);
      }
    }

    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-auth-delete-login-race-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const providerId = 'provider-delete-login-race';
    const providerUserId = 'provider-user-delete-login-race';
    const secrets = new LoginSecretBarrierStore();
    const providers = {
      authenticateUser: async () => ({
        accessToken: 'fresh-browser-access-token',
        userId: providerUserId,
        username: 'Alice'
      })
    } as unknown as ProviderService;
    const auth = new AuthService(repository, secrets, providers);
    await auth.configure({
      providerId,
      defaultProfileId: 'profile-a',
      allowedProfileIds: ['profile-a'],
      reportPlaybackActivity: true
    });

    const pendingLogin = auth.login({
      method: 'jellyfin',
      username: 'alice',
      password: 'password'
    });
    await secrets.putEntered.promise;
    const identity = (await repository.listUserIdentities())[0]!;
    const pendingDelete = auth.deleteUser(identity.value.id, identity.revision, {
      requesterId: 'different-owner'
    });
    secrets.continuePut.resolve();

    const loggedIn = await pendingLogin;
    await expect(pendingDelete).resolves.toBe(true);
    await expect(auth.authenticate(browser(loggedIn.token))).rejects.toThrow(
      'Authentication is required'
    );
    await expect(repository.getUserIdentity(identity.value.id)).resolves.toBeUndefined();
    await expect(secrets.get(`browser-session:${hashToken(loggedIn.token)}`)).rejects.toThrow(
      'Secret not found'
    );
    repository.close();
  });

  it('does not clean up a durable credential while its login is pending', async () => {
    class LoginSecretBarrierStore extends MemorySecretStore {
      readonly putEntered = Promise.withResolvers<void>();
      readonly continuePut = Promise.withResolvers<void>();

      override async put(ref: string, value: string): Promise<void> {
        this.putEntered.resolve();
        await this.continuePut.promise;
        await super.put(ref, value);
      }
    }

    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-auth-cleanup-login-race-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const secrets = new LoginSecretBarrierStore();
    const providers = {
      authenticateUser: async () => ({
        accessToken: 'pending-browser-access-token',
        userId: 'provider-user-cleanup-login-race',
        username: 'Alice'
      })
    } as unknown as ProviderService;
    const auth = new AuthService(repository, secrets, providers);
    await auth.configure({
      providerId: 'provider-cleanup-login-race',
      defaultProfileId: 'profile-a',
      allowedProfileIds: ['profile-a'],
      reportPlaybackActivity: true
    });

    const pendingLogin = auth.login({
      method: 'jellyfin',
      username: 'alice',
      password: 'password'
    });
    await secrets.putEntered.promise;
    const cleanup = auth.cleanup();
    await expect(repository.listSettingsByPrefix('auth.browserCredential.')).resolves.toHaveLength(
      1
    );
    secrets.continuePut.resolve();

    const loggedIn = await pendingLogin;
    await cleanup;
    const principal = await auth.authenticate(browser(loggedIn.token));
    await expect(auth.credential(principal)).resolves.toBe('pending-browser-access-token');
    await auth.logout(loggedIn.token);
    await expect(repository.listSettingsByPrefix('auth.browserCredential.')).resolves.toEqual([]);
    repository.close();
  });

  it('serializes login behind an orphan scan that has already started', async () => {
    class CredentialListBarrierRepository extends SqliteRepository {
      readonly listEntered = Promise.withResolvers<void>();
      readonly continueList = Promise.withResolvers<void>();
      readonly identityCreated = Promise.withResolvers<void>();
      credentialPutCalled = false;
      blockList = true;

      override async listSettingsByPrefix(prefix: string) {
        if (this.blockList && prefix === 'auth.browserCredential.') {
          this.blockList = false;
          this.listEntered.resolve();
          await this.continueList.promise;
        }
        return super.listSettingsByPrefix(prefix);
      }

      override async createUserIdentity(
        identity: Parameters<SqliteRepository['createUserIdentity']>[0]
      ) {
        const record = await super.createUserIdentity(identity);
        this.identityCreated.resolve();
        return record;
      }

      override async putSetting(key: string, value: string): Promise<void> {
        if (key.startsWith('auth.browserCredential.')) this.credentialPutCalled = true;
        await super.putSetting(key, value);
      }
    }

    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-auth-list-login-race-'));
    directories.push(directory);
    const repository = new CredentialListBarrierRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const secrets = new MemorySecretStore();
    const providers = {
      authenticateUser: async () => ({
        accessToken: 'serialized-browser-access-token',
        userId: 'provider-user-list-login-race',
        username: 'Alice'
      })
    } as unknown as ProviderService;
    const auth = new AuthService(repository, secrets, providers);
    await auth.configure({
      providerId: 'provider-list-login-race',
      defaultProfileId: 'profile-a',
      allowedProfileIds: ['profile-a'],
      reportPlaybackActivity: true
    });

    const cleanup = auth.cleanup();
    await repository.listEntered.promise;
    const pendingLogin = auth.login({
      method: 'jellyfin',
      username: 'alice',
      password: 'password'
    });
    await repository.identityCreated.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(repository.credentialPutCalled).toBe(false);
    repository.continueList.resolve();

    await cleanup;
    const loggedIn = await pendingLogin;
    const principal = await auth.authenticate(browser(loggedIn.token));
    await expect(auth.credential(principal)).resolves.toBe('serialized-browser-access-token');
    repository.close();
  });

  it('deletes durable browser credentials after an auth-service restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-auth-restart-delete-'));
    directories.push(directory);
    const repository = new SqliteRepository(join(directory, 'state.sqlite3'));
    await repository.migrate();
    const secrets = new MemorySecretStore();
    const providerId = 'provider-restart-delete';
    const providerUserId = 'provider-user-restart-delete';
    const providers = {
      authenticateUser: async () => ({
        accessToken: 'durable-browser-access-token',
        userId: providerUserId,
        username: 'Alice'
      })
    } as unknown as ProviderService;
    const first = new AuthService(repository, secrets, providers);
    await first.configure({
      providerId,
      defaultProfileId: 'profile-a',
      allowedProfileIds: ['profile-a'],
      reportPlaybackActivity: true
    });
    const loggedIn = await first.login({
      method: 'jellyfin',
      username: 'alice',
      password: 'password'
    });
    const identity = (await repository.listUserIdentities())[0]!;
    const secretRef = `browser-session:${hashToken(loggedIn.token)}`;
    await expect(secrets.get(secretRef)).resolves.toBe('durable-browser-access-token');

    const restarted = new AuthService(repository, secrets, providers);
    await expect(
      restarted.deleteUser(identity.value.id, identity.revision, {
        requesterId: 'different-owner'
      })
    ).resolves.toBe(true);

    await expect(secrets.get(secretRef)).rejects.toThrow('Secret not found');
    await expect(repository.listSettingsByPrefix('auth.browserCredential.')).resolves.toEqual([]);
    repository.close();
  });
});
