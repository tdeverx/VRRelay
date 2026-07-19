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

interface BrowserSession {
  csrfToken: string;
  expiresAt: number;
  authMethod: 'jellyfin' | 'recovery';
  identityId?: string;
  providerId?: string;
  providerUserId?: string;
  secretRef?: string;
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

    if (!this.providers || !this.secrets)
      throw new ApplicationError('sign_in_unavailable', 'Jellyfin sign-in is unavailable', 503);
    const configuration = await this.configuration();
    if (!configuration)
      throw new ApplicationError(
        'sign_in_not_configured',
        'Jellyfin sign-in is not configured',
        409
      );
    const providerIdentity = await this.providers.authenticateUser(
      configuration.providerId,
      request.username,
      request.password
    );
    if (!providerIdentity.userId)
      throw new UnauthorizedError('Provider did not return a user identity');

    const identityId = hashToken(`${configuration.providerId}\0${providerIdentity.userId}`);
    const now = new Date().toISOString();
    let record = await this.repository.getUserIdentity(identityId);
    if (!record) {
      record = await this.repository.createUserIdentity({
        id: identityId,
        providerId: configuration.providerId,
        providerUserId: providerIdentity.userId,
        displayName: providerIdentity.username ?? request.username,
        roles: ['user'],
        defaultProfileId: configuration.defaultProfileId,
        allowedProfileIds: [...configuration.allowedProfileIds],
        firstSeenAt: now,
        lastSeenAt: now
      });
    } else {
      const refreshed: UserIdentity = {
        ...record.value,
        displayName: providerIdentity.username ?? request.username,
        lastSeenAt: now
      };
      const updated = await this.repository.compareAndSetUserIdentity(refreshed, record.revision);
      if (updated.applied) record = updated.record;
      else if (updated.current) record = updated.current;
    }

    const secretRef = `browser-session:${tokenHash}`;
    await this.secrets.put(secretRef, providerIdentity.accessToken);
    this.#sessions.set(tokenHash, {
      csrfToken,
      expiresAt,
      authMethod: 'jellyfin',
      identityId,
      providerId: configuration.providerId,
      providerUserId: providerIdentity.userId,
      secretRef
    });
    return {
      token,
      csrfToken,
      expiresAt: new Date(expiresAt).toISOString(),
      user: this.publicPrincipal(this.#principalFromIdentity(record.value, csrfToken, secretRef))
    };
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
    const tokenHash = hashToken(token);
    const session = this.#sessions.get(tokenHash);
    this.#sessions.delete(tokenHash);
    if (session?.secretRef && this.secrets)
      await this.secrets.delete(session.secretRef).catch(() => undefined);
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
    if (current.value.roles.includes('owner') && !update.roles.includes('owner')) {
      const owners = (await this.repository.listUserIdentities()).filter(({ value }) =>
        value.roles.includes('owner')
      );
      if (owners.length <= 1)
        throw new ApplicationError('last_owner', 'The last assigned owner cannot be demoted', 409);
    }
    const value: UserIdentity = {
      ...current.value,
      roles: [...new Set(update.roles)],
      allowedProfileIds: [...new Set(update.allowedProfileIds)],
      ...(update.defaultProfileId ? { defaultProfileId: update.defaultProfileId } : {})
    };
    if (value.defaultProfileId && !value.allowedProfileIds.includes(value.defaultProfileId))
      throw new ApplicationError('invalid_profile_access', 'Default profile must be allowed', 409);
    const result = await this.repository.compareAndSetUserIdentity(value, expectedRevision);
    if (!result.applied)
      throw new ApplicationError('revision_conflict', 'User was changed by another request', 409);
    return result.record;
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
    for (const [tokenHash, session] of this.#sessions) {
      if (session.expiresAt > Date.now()) continue;
      this.#sessions.delete(tokenHash);
      if (session.secretRef && this.secrets)
        await this.secrets.delete(session.secretRef).catch(() => undefined);
    }
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
