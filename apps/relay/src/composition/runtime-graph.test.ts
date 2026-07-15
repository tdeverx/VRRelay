// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { CompositionKind } from './role-plan.js';
import {
  constructRuntimeGraph,
  type RuntimeComponent,
  ROLE_RUNTIME_COMPONENTS
} from './runtime-graph.js';

function trace(kind: CompositionKind): RuntimeComponent[] {
  const components: RuntimeComponent[] = [];
  constructRuntimeGraph(kind, { construct: (component) => void components.push(component) });
  return components;
}

describe('role-scoped runtime dependency graphs', () => {
  it.each([
    ['controller', ROLE_RUNTIME_COMPONENTS.controller],
    ['source-worker', ROLE_RUNTIME_COMPONENTS['source-worker']],
    ['ingest-origin', ROLE_RUNTIME_COMPONENTS['ingest-origin']],
    ['edge', ROLE_RUNTIME_COMPONENTS.edge],
    ['standalone', ROLE_RUNTIME_COMPONENTS.standalone]
  ] as const)(
    'constructs the declared %s graph through an injectable factory',
    (kind, expected) => {
      expect(trace(kind)).toEqual(expected);
    }
  );

  it('keeps controller-only administration and scheduling out of dedicated data-plane roles', () => {
    const forbidden: RuntimeComponent[] = [
      'profile-service',
      'certificate-authority',
      'cluster-service',
      'agent-controller',
      'backend-service',
      'auth-service',
      'audit-service',
      'admin-server'
    ];
    for (const kind of ['source-worker', 'ingest-origin', 'edge'] as const)
      for (const component of forbidden) expect(trace(kind)).not.toContain(component);
  });

  it('gives each dedicated data-plane role only its owned service surface', () => {
    expect(trace('source-worker')).toEqual(
      expect.arrayContaining([
        'provider-service',
        'media-capabilities',
        'session-service',
        'node-agent',
        'source-worker-server'
      ])
    );
    for (const component of ['live-service', 'edge-server', 'managed-mediamtx'] as const)
      expect(trace('source-worker')).not.toContain(component);

    expect(trace('ingest-origin')).toEqual(
      expect.arrayContaining([
        'live-service',
        'live-normalizer',
        'node-agent',
        'ingest-origin-server',
        'managed-mediamtx'
      ])
    );
    for (const component of ['provider-service', 'session-service', 'edge-server'] as const)
      expect(trace('ingest-origin')).not.toContain(component);

    expect(trace('edge')).toEqual(
      expect.arrayContaining(['object-store', 'session-service', 'node-agent', 'edge-server'])
    );
    for (const component of [
      'media-capabilities',
      'provider-service',
      'live-service',
      'managed-mediamtx'
    ] as const)
      expect(trace('edge')).not.toContain(component);
  });
});
