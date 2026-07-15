// SPDX-License-Identifier: GPL-3.0-or-later
import type { NodeRole } from '@vrrelay/domain';

export type CompositionKind = NodeRole | 'standalone';

export interface RolePlan {
  kind: CompositionKind;
  hostsController: boolean;
  connectsToController: boolean;
  managesLiveIngest: boolean;
}

export const ROLE_PLANS = {
  controller: {
    kind: 'controller',
    hostsController: true,
    connectsToController: false,
    managesLiveIngest: false
  },
  'source-worker': {
    kind: 'source-worker',
    hostsController: false,
    connectsToController: true,
    managesLiveIngest: false
  },
  'ingest-origin': {
    kind: 'ingest-origin',
    hostsController: false,
    connectsToController: true,
    managesLiveIngest: true
  },
  edge: {
    kind: 'edge',
    hostsController: false,
    connectsToController: true,
    managesLiveIngest: false
  },
  standalone: {
    kind: 'standalone',
    hostsController: true,
    connectsToController: false,
    managesLiveIngest: true
  }
} as const satisfies Record<CompositionKind, RolePlan>;

const standaloneRoles = new Set<NodeRole>(['controller', 'source-worker', 'ingest-origin', 'edge']);

export function resolveRolePlan(roles: readonly NodeRole[]): RolePlan {
  if (roles.length === 0)
    throw new Error(
      'VRRELAY_NODE_ROLES must contain exactly one dedicated role or all four roles for standalone'
    );

  const uniqueRoles = new Set(roles);
  if (uniqueRoles.size !== roles.length)
    throw new Error(`VRRELAY_NODE_ROLES contains a duplicate role: ${roles.join(',')}`);

  if (roles.length === 1) return ROLE_PLANS[roles[0]!];
  if (roles.length === standaloneRoles.size && roles.every((role) => standaloneRoles.has(role)))
    return ROLE_PLANS.standalone;

  throw new Error(
    `Unsupported VRRELAY_NODE_ROLES combination: ${roles.join(',')}. ` +
      'Private-production v1 supports one dedicated role or all four roles for standalone.'
  );
}
