// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { NodeRole } from '@vrrelay/domain';
import { resolveRolePlan, ROLE_PLANS } from './role-plan.js';

describe('role composition plans', () => {
  it.each<NodeRole>(['controller', 'source-worker', 'ingest-origin', 'edge'])(
    'selects the dedicated %s composition root',
    (role) => {
      expect(resolveRolePlan([role])).toBe(ROLE_PLANS[role]);
    }
  );

  it('selects standalone only when all four roles are present', () => {
    expect(resolveRolePlan(['edge', 'controller', 'ingest-origin', 'source-worker'])).toBe(
      ROLE_PLANS.standalone
    );
  });

  it.each([
    { roles: [] },
    { roles: ['controller', 'edge'] },
    { roles: ['source-worker', 'ingest-origin', 'edge'] },
    { roles: ['controller', 'controller'] },
    { roles: ['controller', 'source-worker', 'ingest-origin', 'edge', 'edge'] }
  ] satisfies Array<{ roles: NodeRole[] }>)(
    'rejects unsupported or ambiguous role set $roles',
    ({ roles }) => {
      expect(() => resolveRolePlan(roles)).toThrow(/VRRELAY_NODE_ROLES|Unsupported/);
    }
  );

  it('makes controller and ingest ownership explicit for every plan', () => {
    expect(ROLE_PLANS.controller).toMatchObject({
      hostsController: true,
      connectsToController: false,
      managesLiveIngest: false
    });
    expect(ROLE_PLANS['source-worker']).toMatchObject({
      hostsController: false,
      connectsToController: true,
      managesLiveIngest: false
    });
    expect(ROLE_PLANS['ingest-origin']).toMatchObject({
      hostsController: false,
      connectsToController: true,
      managesLiveIngest: true
    });
    expect(ROLE_PLANS.edge).toMatchObject({
      hostsController: false,
      connectsToController: true,
      managesLiveIngest: false
    });
    expect(ROLE_PLANS.standalone).toMatchObject({
      hostsController: true,
      connectsToController: false,
      managesLiveIngest: true
    });
  });
});
