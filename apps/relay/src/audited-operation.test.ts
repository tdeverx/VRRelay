// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '@vrrelay/application';
import type { AuditEvent } from '@vrrelay/domain';
import { auditedOperation } from './audited-operation.js';

function recorder(events: AuditEvent[], failAt?: number): AuditService {
  let writes = 0;
  return new AuditService({
    appendAuditEvent: async (event) => {
      writes += 1;
      if (writes === failAt) throw new Error('audit storage unavailable');
      events.push(event);
    },
    listAuditEvents: async () => events
  });
}

const options = {
  category: 'token' as const,
  action: 'personal-token.create',
  actor: { type: 'administrator' as const, id: 'admin-1' }
};

describe('auditedOperation', () => {
  it('writes correlated attempt and success records around a mutation', async () => {
    const events: AuditEvent[] = [];
    const recorded: AuditEvent[] = [];
    const result = await auditedOperation(
      recorder(events),
      { ...options, onAuditRecorded: (event) => recorded.push(event) },
      async () => ({ id: 'token-1' })
    );

    expect(result).toEqual({ id: 'token-1' });
    expect(events.map(({ outcome }) => outcome)).toEqual(['attempt', 'success']);
    expect(recorded.map(({ outcome }) => outcome)).toEqual(['attempt', 'success']);
    expect(new Set(events.map(({ operationId }) => operationId)).size).toBe(1);
  });

  it('does not begin the mutation when the durable attempt cannot be written', async () => {
    const operation = vi.fn(async () => ({ id: 'token-1' }));
    await expect(auditedOperation(recorder([], 1), options, operation)).rejects.toThrow(
      'audit storage unavailable'
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it('returns a one-time result when the terminal audit write fails', async () => {
    const events: AuditEvent[] = [];
    const failures: unknown[] = [];
    const result = await auditedOperation(
      recorder(events, 2),
      { ...options, onAuditWriteFailure: (failure) => failures.push(failure) },
      async () => ({ id: 'token-1', token: 'one-time-secret' })
    );

    expect(result).toEqual({ id: 'token-1', token: 'one-time-secret' });
    expect(events.map(({ outcome }) => outcome)).toEqual(['attempt']);
    expect(failures).toMatchObject([{ stage: 'success', errorType: 'Error' }]);
    expect(JSON.stringify(failures)).not.toContain('audit storage unavailable');
  });

  it('returns a committed result when terminal audit projection fails', async () => {
    const events: AuditEvent[] = [];
    const failures: unknown[] = [];
    const result = await auditedOperation(
      recorder(events),
      {
        ...options,
        success: () => {
          throw new Error('projection failed');
        },
        onAuditWriteFailure: (failure) => failures.push(failure)
      },
      async () => ({ id: 'token-1', token: 'one-time-secret' })
    );

    expect(result.token).toBe('one-time-secret');
    expect(events.map(({ outcome }) => outcome)).toEqual(['attempt']);
    expect(failures).toMatchObject([{ stage: 'success', errorType: 'Error' }]);
  });

  it('does not let a reporting callback hide a committed one-time result', async () => {
    const result = await auditedOperation(
      recorder([], 2),
      {
        ...options,
        onAuditWriteFailure: () => {
          throw new Error('logger unavailable');
        }
      },
      async () => ({ id: 'token-1', token: 'one-time-secret' })
    );

    expect(result.token).toBe('one-time-secret');
  });

  it('preserves the mutation error if the terminal failure record also fails', async () => {
    const events: AuditEvent[] = [];
    const failures: unknown[] = [];
    const mutationError = new Error('provider validation failed');
    await expect(
      auditedOperation(
        recorder(events, 2),
        { ...options, onAuditWriteFailure: (failure) => failures.push(failure) },
        async () => {
          throw mutationError;
        }
      )
    ).rejects.toBe(mutationError);
    expect(events.map(({ outcome }) => outcome)).toEqual(['attempt']);
    expect(failures).toMatchObject([{ stage: 'failure', errorType: 'Error' }]);
  });
});
