// SPDX-License-Identifier: GPL-3.0-or-later
import type { CompositionKind, RolePlan } from './role-plan.js';

export type RepositorySchemaStartupMethod = 'migrate' | 'assertSchemaCurrent';

const REPOSITORY_SCHEMA_STARTUP_METHODS = {
  controller: 'migrate',
  'source-worker': 'assertSchemaCurrent',
  'ingest-origin': 'assertSchemaCurrent',
  edge: 'assertSchemaCurrent',
  standalone: 'migrate'
} as const satisfies Record<CompositionKind, RepositorySchemaStartupMethod>;

export function repositorySchemaStartupMethod(
  plan: Pick<RolePlan, 'kind'>
): RepositorySchemaStartupMethod {
  return REPOSITORY_SCHEMA_STARTUP_METHODS[plan.kind];
}
