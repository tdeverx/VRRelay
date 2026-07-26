// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyRequest } from 'fastify';
import type {
  ProviderService,
  Repository,
  SecretStore,
  VersionedRecord
} from '@vrrelay/application';
import { ApplicationError, hashToken, opaqueToken, UnauthorizedError } from '@vrrelay/application';
import type { Scope, UserIdentity, UserRole } from '@vrrelay/domain';
import {
  SignInConfigurationRequestSchema,
  type SignInConfigurationRequest
} from '@vrrelay/contracts';

const SIGN_IN_CONFIGURATION_KEY = 'auth.signInConfiguration';
const BROWSER_CREDENTIAL_SETTING_PREFIX = 'auth.browserCredential.';

interface BrowserSession {
  csrfToken: string;
  expiresAt: number;
  authMethod: 'jellyfin' | 'recovery';
  identityId?: string;
  providerId?: string;
  providerUserId?: string;
  secretRef?: string;
  credentialSettingKey?: string;
}

interface PersistedBrowserCredential {
  identityId: string;
  secretRef: string;
  expiresAt: number;
}

export interface Principal {
  kind: 'jellyfin_session' | 'recovery_session' | 'personal_token';
  id?: string;
  displayName?: string;
  roles: readonly UserRole[];
  scopes: readonly Scope[];
  csrfToken?: string;
  providerId?: string;
  providerUserId?: string;
  secretRef?: string;
}

const roleScopes: Record<UserRole, readonly Scope[]> = {
  user: ['catalog:read', 'sessions:create', 'sessions:read', 'sessions:control'],
  operator: ['catalog:read', 'sessions:create', 'sessions:read', 'sessions:control'],
  admin: ['admin'],
  owner: ['admin']
};

export class AuthService {
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #identityOperations = new Map<string, Promise<void>>();
  #credentialOperationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: Repository,
    private readonly secrets?: SecretStore,
    private readonly providers?: ProviderService
  ) {}

  async setupStatus(): Promise<{ configured: boolean }> {
    return { configured: Boolean(await this.repository.getSetting('admin.passwordHash')) };
  }

  async initialize(password: string): Promise<void> {
    if (await this.repository.getSetting('admin.passwordHash'))
      throw new Error('Administrator is already configured');
    const result = await this.repository.putSettingIfAbsent(
      'admin.passwordHash',
      await hash(password, {
        algorithm: 2,
        memoryCost: 65_536,
        timeCost: 3,
        parallelism: 1
      })
    );
    if (!result.inserted) throw new Error('Administrator is already configured');
  }

  async configuration(): Promise<SignInConfigurationRequest | undefined> {
    const stored = await this.repository.getSetting(SIGN_IN_CONFIGURATION_KEY);
    return stored ? SignInConfigurationRequestSchema.parse(JSON.parse(stored)) : undefined;
  }

  async configure(configuration: SignInConfigurationRequest): Promise<void> {
    await this.repository.putSetting(
      SIGN_IN_CONFIGURATION_KEY,
      JSON.stringify(SignInConfigurationRequestSchema.parse(configuration))
    );
  }

  async login(
    input:
      | string
      | { method: 'recovery'; password: string }
      | { method: 'jellyfin'; username: string; password: string }
  ): Promise<{
    token: string;
    csrfToken: string;
    expiresAt: string;
    user: ReturnType<AuthService['publicPrincipal']>;
  }> {
    const request =
      typeof input === 'string' ? { method: 'recovery' as const, password: input } : input;
    const token = opaqueToken();
    const tokenHash = hashToken(token);
    const csrfToken = opaqueToken(24);
    const expiresAt = Date.now() + 12 * 60 * 60 * 1_000;

    if (request.method === 'recovery') {
      const passwordHash = await this.repository.getSetting('admin.passwordHash');
      if (!passwordHash || !(await verify(passwordHash, request.password)))
        throw new UnauthorizedError('Invalid recovery password');
      this.#sessions.set(tokenHash, { csrfToken, expiresAt, authMethod: 'recovery' });
      return {
        token,
        csrfToken,
        expiresAt: new Date(expiresAt).toISOString(),
        user: this.publicPrincipal({
          kind: 'recovery_session',
          id: 'local-recovery-owner',
          displayName: 'Recovery owner',
          roles: ['owner'],
          scopes: ['admin'],
          csrfToken
        })
      };
    }

    const providers = this.providers;
    const secrets = this.secrets;
    if (!providers || !secrets)
      throw new ApplicationError('sign_in_unavailable', 'Jellyfin sign-in is unavailable', 503);
    const configuration = await this.configuration();
    if (!configuration)
      throw new ApplicationError(
        'sign_in_not_configured',
        'Jellyfin sign-in is not configured',
        409
      );
    const providerIdentity = await providers.authenticateUser(
      configuration.providerId,
      request.username,
      request.password
    );
    if (!providerIdentity.userId)
      throw new UnauthorizedError('Provider did not return a user identity');
    const providerUserId = providerIdentity.userId;

    const identityId = hashToken(`${configuration.providerId}\0${providerUserId}`);
    return this.#withIdentityOperation(identityId, async () => {
      const record = await this.#refreshIdentityAfterLogin({
        identityId,
        providerId: configuration.providerId,
        providerUserId,
        displayName: providerIdentity.username ?? request.username,
        defaultProfileId: configuration.defaultProfileId,
        allowedProfileIds: configuration.allowedProfileIds,
        observedAt: new Date().toISOString()
      });

      const secretRef = `browser-session:${tokenHash}`;
      const credentialSettingKey = `${BROWSER_CREDENTIAL_SETTING_PREFIX}${tokenHash}`;
      await this.#withCredentialOperation(async () => {
        try {
          await this.repository.putSetting(
            credentialSettingKey,
            JSON.stringify({
              identityId,
              secretRef,
              expiresAt
            } satisfies PersistedBrowserCredential)
          );
          await secrets.put(secretRef, providerIdentity.accessToken);
          this.#sessions.set(tokenHash, {
            csrfToken,
            expiresAt,
            authMethod: 'jellyfin',
            identityId,
            providerId: configuration.providerId,
            providerUserId,
            secretRef,
            credentialSettingKey
          });
        } catch (error) {
          await this.#deletePersistedBrowserCredential(credentialSettingKey, secretRef).catch(
            () => undefined
          );
          throw error;
        }
      });
      return {
        token,
        csrfToken,
        expiresAt: new Date(expiresAt).toISOString(),
        user: this.publicPrincipal(this.#principalFromIdentity(record.value, csrfToken, secretRef))
      };
    });
  }

  async authenticate(
    request: FastifyRequest,
    requiredScopes: readonly Scope[] = []
  ): Promise<Principal> {
    const cookieToken = request.cookies.vrrelay_session;
    if (cookieToken) {
      const session = this.#sessions.get(hashToken(cookieToken));
      if (session && session.expiresAt > Date.now()) {
        const principal = await this.#browserPrincipal(session);
        this.#assertScopes(principal, requiredScopes);
        return principal;
      }
    }
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const usedAtMilliseconds = Date.now();
      const usedAt = new Date(usedAtMilliseconds).toISOString();
      const record = await this.repository.usePersonalToken({
        tokenHash: hashToken(authorization.slice(7)),
        usedAt,
        touchBefore: new Date(usedAtMilliseconds - 60_000).toISOString()
      });
      if (record) {
        const principal: Principal = {
          kind: 'personal_token',
          id: record.id,
          roles: [],
          scopes: record.scopes
        };
        this.#assertScopes(principal, requiredScopes);
        return principal;
      }
    }
    throw new UnauthorizedError();
  }

  publicPrincipal(principal: Principal) {
    return {
      id: principal.id ?? '',
      displayName: principal.displayName ?? 'API client',
      authMethod:
        principal.kind === 'jellyfin_session'
          ? ('jellyfin' as const)
          : principal.kind === 'recovery_session'
            ? ('recovery' as const)
            : ('personal_token' as const),
      roles: [...principal.roles],
      permissions: [...principal.scopes],
      ...(principal.providerId ? { providerId: principal.providerId } : {})
    };
  }

  requireCsrf(request: FastifyRequest, principal: Principal): void {
    if (principal.kind === 'personal_token') return;
    if (!principal.csrfToken || request.headers['x-csrf-token'] !== principal.csrfToken)
      throw new UnauthorizedError('CSRF token is missing or invalid');
  }

  async credential(principal: Principal): Promise<string> {
    if (principal.kind !== 'jellyfin_session' || !principal.secretRef || !this.secrets)
      throw new ApplicationError('catalog_unavailable', 'A Jellyfin sign-in is required', 403);
    return this.secrets.get(principal.secretRef);
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.#withCredentialOperation(async () => {
      const tokenHash = hashToken(token);
      const session = this.#sessions.get(tokenHash);
      this.#sessions.delete(tokenHash);
      if (session?.secretRef && session.credentialSettingKey)
        await this.#deletePersistedBrowserCredential(
          session.credentialSettingKey,
          session.secretRef
        ).catch(() => undefined);
    });
  }

  async listUsers(): Promise<Array<VersionedRecord<UserIdentity>>> {
    return this.repository.listUserIdentities();
  }

  async updateUser(
    id: string,
    expectedRevision: number,
    update: Pick<UserIdentity, 'roles' | 'allowedProfileIds'> & { defaultProfileId?: string }
  ): Promise<VersionedRecord<UserIdentity>> {
    const current = await this.repository.getUserIdentity(id);
    if (!current) throw new ApplicationError('not_found', 'User was not found', 404);
    if (current.revision !== expectedRevision)
      throw new ApplicationError('revision_conflict', 'User was changed by another request', 409);
    const value: UserIdentity = {
      ...current.value,
      roles: [...new Set(update.roles)],
      allowedProfileIds: [...new Set(update.allowedProfileIds)],
      ...(update.defaultProfileId ? { defaultProfileId: update.defaultProfileId } : {})
    };
    if (value.defaultProfileId && !value.allowedProfileIds.includes(value.defaultProfileId))
      throw new ApplicationError('invalid_profile_access', 'Default profile must be allowed', 409);
    const result = await this.repository.compareAndSetUserIdentityPreservingOwner(
      value,
      expectedRevision
    );
    if (!result.applied && result.reason === 'dependency-conflict')
      throw new ApplicationError('last_owner', 'The last assigned owner cannot be demoted', 409);
    if (!result.applied)
      throw new ApplicationError('revision_conflict', 'User was changed by another request', 409);
    return result.record;
  }

  async listUsersLastSeenBefore(
    lastSeenBefore: string,
    limit = 100
  ): Promise<Array<VersionedRecord<UserIdentity>>> {
    return this.repository.listUserIdentitiesLastSeenBefore(lastSeenBefore, limit);
  }

  hasActiveBrowserSession(identityId: string, now = Date.now()): boolean {
    for (const session of this.#sessions.values())
      if (session.identityId === identityId && session.expiresAt > now) return true;
    return false;
  }

  async deleteUser(
    id: string,
    expectedRevision: number,
    options: { requesterId?: string; lastSeenBefore?: string } = {}
  ): Promise<boolean> {
    if (options.requesterId === id)
      throw new ApplicationError('cannot_delete_self', 'You cannot delete your own user', 409);
    return this.#withIdentityOperation(id, async () => {
      if (options.lastSeenBefore && this.hasActiveBrowserSession(id)) return false;
      const result = await this.repository.deleteUserIdentityPreservingOwner(
        id,
        expectedRevision,
        options.lastSeenBefore
      );
      if (!result.applied) {
        if (
          options.lastSeenBefore &&
          (result.reason === 'invalid-state' || result.reason === 'revision-conflict')
        )
          return false;
        if (result.reason === 'not-found')
          throw new ApplicationError('not_found', 'User was not found', 404);
        if (result.reason === 'revision-conflict')
          throw new ApplicationError(
            'revision_conflict',
            'User was changed by another request',
            409
          );
        const dependencies = result.dependencies ?? [];
        if (dependencies.includes('assigned-owner'))
          throw new ApplicationError(
            'last_owner',
            'The last assigned owner cannot be deleted',
            409
          );
        throw new ApplicationError(
          'user_has_owned_resources',
          'Delete the user’s sessions and live channels before deleting the user',
          409,
          { dependencies }
        );
      }
      await this.#withCredentialOperation(async () => {
        const secretRefs: string[] = [];
        for (const [tokenHash, session] of this.#sessions) {
          if (session.identityId !== id) continue;
          this.#sessions.delete(tokenHash);
          if (session.secretRef) secretRefs.push(session.secretRef);
        }
        const persisted = (await this.#persistedBrowserCredentials()).filter(
          ({ credential }) => credential.identityId === id
        );
        await Promise.all(
          persisted.map(({ key, credential }) =>
            this.#deletePersistedBrowserCredential(key, credential.secretRef)
          )
        );
        if (this.secrets) {
          const persistedRefs = new Set(persisted.map(({ credential }) => credential.secretRef));
          await Promise.all(
            secretRefs
              .filter((secretRef) => !persistedRefs.has(secretRef))
              .map((secretRef) => this.secrets!.delete(secretRef))
          );
        }
      });
      return true;
    });
  }

  async createPersonalToken(name: string, scopes: Scope[], expiresAt: string | null) {
    const token = `vrr_${opaqueToken()}`;
    const record = {
      id: randomUUID(),
      name,
      tokenHash: hashToken(token),
      scopes,
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: new Date().toISOString()
    };
    await this.repository.putPersonalToken(record);
    const { tokenHash: _tokenHash, ...publicRecord } = record;
    return { ...publicRecord, token };
  }

  async listPersonalTokens() {
    return (await this.repository.listPersonalTokens()).map(
      ({ tokenHash: _tokenHash, ...token }) => token
    );
  }

  async revokePersonalToken(id: string): Promise<void> {
    await this.repository.revokePersonalToken(id);
  }

  async cleanup(): Promise<void> {
    await this.#withCredentialOperation(async () => {
      for (const [tokenHash, session] of this.#sessions) {
        if (session.expiresAt > Date.now()) continue;
        this.#sessions.delete(tokenHash);
        if (session.secretRef && session.credentialSettingKey)
          await this.#deletePersistedBrowserCredential(
            session.credentialSettingKey,
            session.secretRef
          ).catch(() => undefined);
      }
      const activeSettingKeys = new Set(
        [...this.#sessions.values()]
          .map((session) => session.credentialSettingKey)
          .filter((key): key is string => Boolean(key))
      );
      for (const { key, credential } of await this.#persistedBrowserCredentials()) {
        if (activeSettingKeys.has(key)) continue;
        await this.#deletePersistedBrowserCredential(key, credential.secretRef).catch(
          () => undefined
        );
      }
    });
  }

  async recover(): Promise<void> {
    await this.#withCredentialOperation(async () => {
      for (const { key, credential } of await this.#persistedBrowserCredentials())
        await this.#deletePersistedBrowserCredential(key, credential.secretRef);
    });
  }

  async #refreshIdentityAfterLogin(input: {
    identityId: string;
    providerId: string;
    providerUserId: string;
    displayName: string;
    defaultProfileId: string;
    allowedProfileIds: readonly string[];
    observedAt: string;
  }): Promise<VersionedRecord<UserIdentity>> {
    let record = await this.repository.getUserIdentity(input.identityId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!record) {
        try {
          return await this.repository.createUserIdentity({
            id: input.identityId,
            providerId: input.providerId,
            providerUserId: input.providerUserId,
            displayName: input.displayName,
            roles: ['user'],
            defaultProfileId: input.defaultProfileId,
            allowedProfileIds: [...input.allowedProfileIds],
            firstSeenAt: input.observedAt,
            lastSeenAt: input.observedAt
          });
        } catch (error) {
          record = await this.repository.getUserIdentity(input.identityId);
          if (!record) throw error;
        }
      }
      const refreshed: UserIdentity = {
        ...record.value,
        displayName: input.displayName,
        lastSeenAt: input.observedAt
      };
      const updated = await this.repository.compareAndSetUserIdentity(refreshed, record.revision);
      if (updated.applied) return updated.record;
      if (updated.current && updated.current.value.lastSeenAt >= input.observedAt)
        return updated.current;
      record = updated.current;
    }
    throw new ApplicationError(
      'sign_in_conflict',
      'The user changed repeatedly during sign-in; try again',
      409
    );
  }

  async #withIdentityOperation<T>(identityId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#identityOperations.get(identityId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#identityOperations.set(identityId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#identityOperations.get(identityId) === tail)
        this.#identityOperations.delete(identityId);
    }
  }

  async #withCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#credentialOperationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#credentialOperationTail = tail;
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#credentialOperationTail === tail) this.#credentialOperationTail = Promise.resolve();
    }
  }

  async #persistedBrowserCredentials(): Promise<
    Array<{ key: string; credential: PersistedBrowserCredential }>
  > {
    const records = await this.repository.listSettingsByPrefix(BROWSER_CREDENTIAL_SETTING_PREFIX);
    return records.map(({ key, value }) => {
      const credential = JSON.parse(value) as Partial<PersistedBrowserCredential>;
      const tokenHash = key.slice(BROWSER_CREDENTIAL_SETTING_PREFIX.length);
      if (
        !/^[0-9a-f]{64}$/.test(tokenHash) ||
        typeof credential.identityId !== 'string' ||
        !credential.identityId ||
        credential.secretRef !== `browser-session:${tokenHash}` ||
        typeof credential.expiresAt !== 'number' ||
        !Number.isFinite(credential.expiresAt)
      )
        throw new Error(`Invalid persisted browser credential metadata: ${key}`);
      return { key, credential: credential as PersistedBrowserCredential };
    });
  }

  async #deletePersistedBrowserCredential(key: string, secretRef: string): Promise<void> {
    if (this.secrets) await this.secrets.delete(secretRef);
    await this.repository.deleteSetting(key);
  }

  async #browserPrincipal(session: BrowserSession): Promise<Principal> {
    if (session.authMethod === 'recovery')
      return {
        kind: 'recovery_session',
        id: 'local-recovery-owner',
        displayName: 'Recovery owner',
        roles: ['owner'],
        scopes: ['admin'],
        csrfToken: session.csrfToken
      };
    const record = session.identityId
      ? await this.repository.getUserIdentity(session.identityId)
      : undefined;
    if (!record) throw new UnauthorizedError();
    return this.#principalFromIdentity(record.value, session.csrfToken, session.secretRef);
  }

  #principalFromIdentity(identity: UserIdentity, csrfToken: string, secretRef?: string): Principal {
    const scopes = [...new Set(identity.roles.flatMap((role) => roleScopes[role]))];
    return {
      kind: 'jellyfin_session',
      id: identity.id,
      displayName: identity.displayName,
      roles: identity.roles,
      scopes,
      csrfToken,
      providerId: identity.providerId,
      providerUserId: identity.providerUserId,
      ...(secretRef ? { secretRef } : {})
    };
  }

  #assertScopes(principal: Principal, required: readonly Scope[]): void {
    if (principal.scopes.includes('admin')) return;
    if (required.some((scope) => !principal.scopes.includes(scope)))
      throw new UnauthorizedError('Token does not have the required scope');
  }
}
