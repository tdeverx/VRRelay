// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ROLE_PLANS } from './role-plan.js';
import { repositorySchemaStartupMethod } from './schema-startup.js';

describe('repository schema startup policy', () => {
  it.each([
    ['controller', ROLE_PLANS.controller, 'migrate'],
    ['source-worker', ROLE_PLANS['source-worker'], 'assertSchemaCurrent'],
    ['ingest-origin', ROLE_PLANS['ingest-origin'], 'assertSchemaCurrent'],
    ['edge', ROLE_PLANS.edge, 'assertSchemaCurrent'],
    ['standalone', ROLE_PLANS.standalone, 'migrate']
  ] as const)('%s uses its repository schema startup method', (_kind, plan, expectedMethod) => {
    expect(repositorySchemaStartupMethod(plan)).toBe(expectedMethod);
  });
});
