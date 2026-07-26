// SPDX-License-Identifier: GPL-3.0-or-later
import type { AuditService, Repository, SessionService } from '@vrrelay/application';
import {
  RetentionConfigurationSchema,
  type RetentionConfiguration,
  type UpdateRetentionConfigurationRequest
} from '@vrrelay/contracts';
import { auditedOperation } from './audited-operation.js';
import type { AuthService } from './auth.js';

const RETENTION_CONFIGURATION_KEY = 'retention.configuration';
const SWEEP_LIMIT = 100;

export interface RetentionSweepResult {
  sessionsDeleted: number;
  usersDeleted: number;
  failures: number;
}

export class RetentionService {
  constructor(
    private readonly repository: Repository,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
    private readonly audit: Pick<AuditService, 'record'>,
    private readonly onError?: (
      error: unknown,
      target: { type: 'session' | 'user'; id: string }
    ) => void
  ) {}

  async configuration(): Promise<RetentionConfiguration> {
    const stored = await this.repository.getSetting(RETENTION_CONFIGURATION_KEY);
    return RetentionConfigurationSchema.parse(stored ? JSON.parse(stored) : {});
  }

  async configure(
    configuration: UpdateRetentionConfigurationRequest
  ): Promise<RetentionConfiguration> {
    const parsed = RetentionConfigurationSchema.parse(configuration);
    await this.repository.putSetting(RETENTION_CONFIGURATION_KEY, JSON.stringify(parsed));
    return parsed;
  }

  async sweep(now = Date.now()): Promise<RetentionSweepResult> {
    const configuration = await this.configuration();
    const result: RetentionSweepResult = {
      sessionsDeleted: 0,
      usersDeleted: 0,
      failures: 0
    };

    for (const session of await this.repository.listSessionDeletionPending(SWEEP_LIMIT)) {
      try {
        await auditedOperation(
          this.audit,
          {
            category: 'session',
            action: 'session.delete.retry',
            actor: { type: 'system' },
            target: { type: 'session', id: session.id }
          },
          () => this.sessions.delete(session.id)
        );
        result.sessionsDeleted += 1;
      } catch (error) {
        result.failures += 1;
        this.onError?.(error, { type: 'session', id: session.id });
      }
    }

    if (configuration.sessionInactivityDeletionHours !== null) {
      const inactiveBefore = new Date(
        now - configuration.sessionInactivityDeletionHours * 60 * 60 * 1_000
      ).toISOString();
      const sessions = await this.repository.listInactiveSessions(inactiveBefore, SWEEP_LIMIT);
      for (const session of sessions) {
        try {
          const deleted = await auditedOperation(
            this.audit,
            {
              category: 'session',
              action: 'session.expire',
              actor: { type: 'system' },
              target: { type: 'session', id: session.id },
              context: {
                inactiveBefore,
                lastPlaybackActivityAt: session.lastPlaybackActivityAt ?? session.createdAt
              },
              success: (applied) => ({
                outcome: applied ? 'success' : 'failure',
                context: { applied }
              })
            },
            () => this.sessions.deleteIfInactive(session.id, inactiveBefore)
          );
          if (deleted) result.sessionsDeleted += 1;
        } catch (error) {
          result.failures += 1;
          this.onError?.(error, { type: 'session', id: session.id });
        }
      }
    }

    if (configuration.staleUserPurgeDays !== null) {
      const lastSeenBefore = new Date(
        now - configuration.staleUserPurgeDays * 24 * 60 * 60 * 1_000
      ).toISOString();
      const users = await this.auth.listUsersLastSeenBefore(lastSeenBefore, SWEEP_LIMIT);
      for (const user of users) {
        if (user.value.roles.some((role) => role === 'admin' || role === 'owner')) continue;
        if (this.auth.hasActiveBrowserSession(user.value.id, now)) continue;
        try {
          const deleted = await auditedOperation(
            this.audit,
            {
              category: 'authentication',
              action: 'user.purge',
              actor: { type: 'system' },
              target: { type: 'user', id: user.value.id },
              context: { lastSeenBefore, lastSeenAt: user.value.lastSeenAt },
              success: (applied) => ({
                outcome: applied ? 'success' : 'failure',
                context: { applied }
              })
            },
            () =>
              this.auth.deleteUser(user.value.id, user.revision, {
                lastSeenBefore
              })
          );
          if (deleted) result.usersDeleted += 1;
        } catch (error) {
          result.failures += 1;
          this.onError?.(error, { type: 'user', id: user.value.id });
        }
      }
    }

    return result;
  }
}
