// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { AuditActor, AuditCategory, AuditEvent, AuditTarget } from '@vrrelay/domain';
import type { AuditRepository } from './index.js';

type AuditContextValue = string | number | boolean | null;

const sensitiveKey =
  /(?:authorization|cookie|credential|password|private|secret|token|api[-_]?key|certificate|pem)/i;

export interface RecordAuditEventInput {
  operationId?: string;
  category: AuditCategory;
  action: string;
  outcome: AuditEvent['outcome'];
  actor?: AuditActor;
  target?: AuditTarget;
  message?: string;
  context?: Readonly<Record<string, AuditContextValue>>;
  occurredAt?: string;
}

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  async record(input: RecordAuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: randomUUID(),
      operationId: input.operationId ?? randomUUID(),
      category: input.category,
      action: input.action,
      outcome: input.outcome,
      actor: input.actor ?? { type: 'system' },
      ...(input.target ? { target: input.target } : {}),
      ...(input.message ? { message: input.message.slice(0, 500) } : {}),
      context: this.#redactContext(input.context ?? {}),
      occurredAt: input.occurredAt ?? new Date().toISOString()
    };
    await this.repository.appendAuditEvent(event);
    return event;
  }

  #redactContext(
    context: Readonly<Record<string, AuditContextValue>>
  ): Record<string, AuditContextValue> {
    return Object.fromEntries(
      Object.entries(context).map(([key, value]) => [
        key,
        sensitiveKey.test(key) ? '[redacted]' : value
      ])
    );
  }
}
