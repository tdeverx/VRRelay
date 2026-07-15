// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApplicationError, type AuditService } from '@vrrelay/application';
import type { AuditActor, AuditTarget } from '@vrrelay/domain';
import type { Principal } from './auth.js';

type AuditContext = Readonly<Record<string, string | number | boolean | null>>;

export interface AuditWriteFailure {
  operationId: string;
  stage: 'attempt' | 'success' | 'failure';
  errorType: string;
}

export interface AuditedOperationOptions<T> {
  category: 'cluster' | 'provider' | 'backend' | 'session' | 'token';
  action: string;
  actor: AuditActor;
  target?: AuditTarget;
  context?: AuditContext;
  success?: (result: T) => {
    outcome?: 'success' | 'failure';
    target?: AuditTarget;
    context?: AuditContext;
  };
  failure?: {
    outcome?: 'failure' | 'denied';
    target?: AuditTarget;
    context?: AuditContext;
  };
  onAuditWriteFailure?: (failure: AuditWriteFailure) => void;
}

function auditFailureType(error: unknown): string {
  if (error instanceof ApplicationError) return error.code;
  if (error instanceof z.ZodError) return 'invalid_request';
  return error instanceof Error ? error.name : 'unknown';
}

function reportAuditWriteFailure<T>(
  options: AuditedOperationOptions<T>,
  failure: AuditWriteFailure
): void {
  try {
    options.onAuditWriteFailure?.(failure);
  } catch {
    // Reporting must never hide the authoritative mutation or audit failure.
  }
}

export function auditActor(principal: Principal): AuditActor {
  return principal.kind === 'admin_session'
    ? { type: 'administrator', ...(principal.id ? { id: principal.id } : {}) }
    : { type: 'token', ...(principal.id ? { id: principal.id } : {}) };
}

export async function auditedOperation<T>(
  audit: Pick<AuditService, 'record'>,
  options: AuditedOperationOptions<T>,
  operation: () => Promise<T>
): Promise<T> {
  const operationId = randomUUID();
  try {
    await audit.record({
      operationId,
      category: options.category,
      action: options.action,
      outcome: 'attempt',
      actor: options.actor,
      ...(options.target ? { target: options.target } : {}),
      ...(options.context ? { context: options.context } : {})
    });
  } catch (error) {
    reportAuditWriteFailure(options, {
      operationId,
      stage: 'attempt',
      errorType: auditFailureType(error)
    });
    throw error;
  }

  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await audit.record({
        operationId,
        category: options.category,
        action: options.action,
        outcome: options.failure?.outcome ?? 'failure',
        actor: options.actor,
        ...((options.failure?.target ?? options.target)
          ? { target: options.failure?.target ?? options.target }
          : {}),
        context: {
          ...options.context,
          ...options.failure?.context,
          errorType: auditFailureType(error)
        }
      });
    } catch (auditError) {
      reportAuditWriteFailure(options, {
        operationId,
        stage: 'failure',
        errorType: auditFailureType(auditError)
      });
    }
    throw error;
  }

  try {
    const success = options.success?.(result);
    const target = success?.target ?? options.target;
    await audit.record({
      operationId,
      category: options.category,
      action: options.action,
      outcome: success?.outcome ?? 'success',
      actor: options.actor,
      ...(target ? { target } : {}),
      context: { ...options.context, ...success?.context }
    });
  } catch (error) {
    reportAuditWriteFailure(options, {
      operationId,
      stage: 'success',
      errorType: auditFailureType(error)
    });
  }
  return result;
}
