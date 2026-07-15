// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@vrrelay/domain';
import { AuditService } from './audit-service.js';

describe('AuditService', () => {
  it('persists structured events while redacting sensitive context keys', async () => {
    const events: AuditEvent[] = [];
    const audit = new AuditService({
      appendAuditEvent: async (event) => void events.push(event),
      listAuditEvents: async () => events
    });

    const event = await audit.record({
      category: 'cluster',
      action: 'node.enrolled',
      outcome: 'success',
      actor: { type: 'administrator', id: 'local-admin' },
      target: { type: 'node', id: 'node-1' },
      context: {
        region: 'eu-west',
        joinToken: 'must-not-be-stored',
        private_key: 'must-not-be-stored',
        workers: 4
      }
    });

    expect(events).toEqual([event]);
    expect(event.context).toEqual({
      region: 'eu-west',
      joinToken: '[redacted]',
      private_key: '[redacted]',
      workers: 4
    });
    expect(event.id).toBeTruthy();
    expect(event.operationId).toBeTruthy();
    expect(Date.parse(event.occurredAt)).not.toBeNaN();
  });

  it('propagates durable-storage failures', async () => {
    const audit = new AuditService({
      appendAuditEvent: async () => {
        throw new Error('audit storage unavailable');
      },
      listAuditEvents: async () => []
    });

    await expect(
      audit.record({ category: 'system', action: 'test', outcome: 'success' })
    ).rejects.toThrow('audit storage unavailable');
  });
});
