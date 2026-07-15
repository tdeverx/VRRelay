// SPDX-License-Identifier: GPL-3.0-or-later
import type { CompositionKind } from './role-plan.js';

export type RuntimeComponent =
  | 'repository'
  | 'secret-store'
  | 'coordination-store'
  | 'object-store'
  | 'event-bus'
  | 'metrics'
  | 'media-capabilities'
  | 'provider-registry'
  | 'provider-service'
  | 'profile-service'
  | 'session-service'
  | 'live-service'
  | 'live-normalizer'
  | 'certificate-authority'
  | 'cluster-service'
  | 'agent-controller'
  | 'node-agent'
  | 'backend-service'
  | 'auth-service'
  | 'audit-service'
  | 'admin-server'
  | 'source-worker-server'
  | 'ingest-origin-server'
  | 'edge-server'
  | 'managed-mediamtx';

export interface RuntimeComponentFactory {
  construct(component: RuntimeComponent): void;
}

export const ROLE_RUNTIME_COMPONENTS = {
  controller: [
    'repository',
    'secret-store',
    'coordination-store',
    'object-store',
    'event-bus',
    'metrics',
    'media-capabilities',
    'provider-registry',
    'provider-service',
    'profile-service',
    'session-service',
    'live-service',
    'certificate-authority',
    'cluster-service',
    'agent-controller',
    'backend-service',
    'auth-service',
    'audit-service',
    'admin-server'
  ],
  'source-worker': [
    'repository',
    'secret-store',
    'coordination-store',
    'object-store',
    'event-bus',
    'metrics',
    'media-capabilities',
    'provider-registry',
    'provider-service',
    'session-service',
    'node-agent',
    'source-worker-server'
  ],
  'ingest-origin': [
    'repository',
    'secret-store',
    'event-bus',
    'metrics',
    'media-capabilities',
    'live-service',
    'live-normalizer',
    'node-agent',
    'ingest-origin-server',
    'managed-mediamtx'
  ],
  edge: [
    'repository',
    'secret-store',
    'coordination-store',
    'object-store',
    'event-bus',
    'metrics',
    'session-service',
    'node-agent',
    'edge-server'
  ],
  standalone: [
    'repository',
    'secret-store',
    'coordination-store',
    'object-store',
    'event-bus',
    'metrics',
    'media-capabilities',
    'provider-registry',
    'provider-service',
    'profile-service',
    'session-service',
    'live-service',
    'live-normalizer',
    'certificate-authority',
    'cluster-service',
    'agent-controller',
    'backend-service',
    'auth-service',
    'audit-service',
    'admin-server',
    'managed-mediamtx'
  ]
} as const satisfies Record<CompositionKind, readonly RuntimeComponent[]>;

export function constructRuntimeGraph(
  kind: CompositionKind,
  factory: RuntimeComponentFactory
): void {
  for (const component of ROLE_RUNTIME_COMPONENTS[kind]) factory.construct(component);
}
