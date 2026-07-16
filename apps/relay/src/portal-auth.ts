// SPDX-License-Identifier: GPL-3.0-or-later
import type { FastifyRequest } from 'fastify';
import type { ProviderService, Repository, SecretStore } from '@vrrelay/application';
import { NotFoundError, UnauthorizedError, hashToken, opaqueToken } from '@vrrelay/application';
import {
  PortalConfigurationRequestSchema,
  type PortalConfigurationRequest
} from '@vrrelay/contracts';

const PORTAL_CONFIGURATION_KEY = 'portal.configuration';

interface PortalSession {
  providerId: string;
  userId: string;
  username: string;
  secretRef: string;
  csrfToken: string;
  expiresAt: number;
}

export interface PortalPrincipal {
  kind: 'portal_user';
  id: string;
  providerId: string;
  userId: string;
  username: string;
  secretRef: string;
  csrfToken: string;
}

export class PortalAuthService {
  readonly #sessions = new Map<string, PortalSession>();

  constructor(
    private readonly repository: Repository,
    private readonly secrets: SecretStore,
    private readonly providers: ProviderService
  ) {}

  async configuration(): Promise<PortalConfigurationRequest | undefined> {
    const stored = await this.repository.getSetting(PORTAL_CONFIGURATION_KEY);
    if (!stored) return undefined;
    return PortalConfigurationRequestSchema.parse(JSON.parse(stored));
  }

  async configure(configuration: PortalConfigurationRequest): Promise<void> {
    await this.repository.putSetting(
      PORTAL_CONFIGURATION_KEY,
      JSON.stringify(PortalConfigurationRequestSchema.parse(configuration))
    );
  }

  async login(
    username: string,
    password: string
  ): Promise<{
    token: string;
    csrfToken: string;
    expiresAt: string;
    user: { id: string; username: string; providerId: string };
  }> {
    const configuration = await this.configuration();
    if (!configuration) throw new NotFoundError('The user portal is not configured');
    const identity = await this.providers.authenticateUser(
      configuration.providerId,
      username,
      password
    );
    if (!identity.userId) throw new UnauthorizedError('Provider did not return a user identity');
    const token = opaqueToken();
    const tokenHash = hashToken(token);
    const csrfToken = opaqueToken(24);
    const expiresAt = Date.now() + 12 * 60 * 60 * 1_000;
    const secretRef = `portal-session:${tokenHash}`;
    await this.secrets.put(secretRef, identity.accessToken);
    this.#sessions.set(tokenHash, {
      providerId: configuration.providerId,
      userId: identity.userId,
      username: identity.username ?? username,
      secretRef,
      csrfToken,
      expiresAt
    });
    return {
      token,
      csrfToken,
      expiresAt: new Date(expiresAt).toISOString(),
      user: {
        id: hashToken(`${configuration.providerId}\0${identity.userId}`),
        username: identity.username ?? username,
        providerId: configuration.providerId
      }
    };
  }

  async authenticate(request: FastifyRequest): Promise<PortalPrincipal> {
    const token = request.cookies.vrrelay_user_session;
    if (!token) throw new UnauthorizedError();
    const tokenHash = hashToken(token);
    const session = this.#sessions.get(tokenHash);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) {
        this.#sessions.delete(tokenHash);
        await this.secrets.delete(session.secretRef).catch(() => undefined);
      }
      throw new UnauthorizedError();
    }
    return {
      kind: 'portal_user',
      id: hashToken(`${session.providerId}\0${session.userId}`),
      providerId: session.providerId,
      userId: session.userId,
      username: session.username,
      secretRef: session.secretRef,
      csrfToken: session.csrfToken
    };
  }

  requireCsrf(request: FastifyRequest, principal: PortalPrincipal): void {
    if (request.headers['x-csrf-token'] !== principal.csrfToken)
      throw new UnauthorizedError('CSRF token is missing or invalid');
  }

  credential(principal: PortalPrincipal): Promise<string> {
    return this.secrets.get(principal.secretRef);
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const tokenHash = hashToken(token);
    const session = this.#sessions.get(tokenHash);
    this.#sessions.delete(tokenHash);
    if (session) await this.secrets.delete(session.secretRef);
  }

  async cleanup(): Promise<void> {
    for (const [hash, session] of this.#sessions) {
      if (session.expiresAt > Date.now()) continue;
      this.#sessions.delete(hash);
      await this.secrets.delete(session.secretRef).catch(() => undefined);
    }
  }
}
