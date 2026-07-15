// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { RelayEvent } from '@vrrelay/contracts';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function createServiceEvent(
  type: RelayEvent['type'],
  payload: Record<string, unknown>,
  sessionId?: string
): RelayEvent {
  return {
    version: 1,
    id: randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {}),
    payload
  };
}
