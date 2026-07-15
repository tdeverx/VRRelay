// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyRequest } from 'fastify';
import type { Repository } from '@vrrelay/application';
import { hashToken, opaqueToken, UnauthorizedError } from '@vrrelay/application';
import type { Scope } from '@vrrelay/domain';

interface AdminSession {
  tokenHash: string;
  csrfToken: string;
  expiresAt: number;
}

export interface Principal {
  kind: 'admin_session' | 'personal_token';
  id?: string;
  scopes: readonly Scope[];
  csrfToken?: string;
}

export class AuthService {
  readonly #sessions = new Map<string, AdminSession>();

  constructor(private readonly repository: Repository) {}

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

  async login(password: string): Promise<{ token: string; csrfToken: string; expiresAt: string }> {
    const passwordHash = await this.repository.getSetting('admin.passwordHash');
    if (!passwordHash || !(await verify(passwordHash, password)))
      throw new UnauthorizedError('Invalid administrator password');
    const token = opaqueToken();
    const csrfToken = opaqueToken(24);
    const expiresAt = Date.now() + 12 * 60 * 60 * 1_000;
    this.#sessions.set(hashToken(token), { tokenHash: hashToken(token), csrfToken, expiresAt });
    return { token, csrfToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  logout(token: string | undefined): void {
    if (token) this.#sessions.delete(hashToken(token));
  }

  async authenticate(
    request: FastifyRequest,
    requiredScopes: readonly Scope[] = []
  ): Promise<Principal> {
    const cookieToken = request.cookies.vrrelay_session;
    if (cookieToken) {
      const session = this.#sessions.get(hashToken(cookieToken));
      if (session && session.expiresAt > Date.now()) {
        const principal: Principal = {
          kind: 'admin_session',
          id: 'local-admin',
          scopes: ['admin'],
          csrfToken: session.csrfToken
        };
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
          scopes: record.scopes
        };
        this.#assertScopes(principal, requiredScopes);
        return principal;
      }
    }
    throw new UnauthorizedError();
  }

  requireCsrf(request: FastifyRequest, principal: Principal): void {
    if (principal.kind !== 'admin_session') return;
    if (!principal.csrfToken || request.headers['x-csrf-token'] !== principal.csrfToken) {
      throw new UnauthorizedError('CSRF token is missing or invalid');
    }
  }

  async createPersonalToken(name: string, scopes: Scope[], expiresAt: string | null) {
    const token = `vrr_${opaqueToken()}`;
    const id = randomUUID();
    const record = {
      id,
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

  cleanup(): void {
    for (const [hash, session] of this.#sessions) {
      if (session.expiresAt <= Date.now()) this.#sessions.delete(hash);
    }
  }

  #assertScopes(principal: Principal, required: readonly Scope[]): void {
    if (principal.scopes.includes('admin')) return;
    if (required.some((scope) => !principal.scopes.includes(scope))) {
      throw new UnauthorizedError('Token does not have the required scope');
    }
  }
}
