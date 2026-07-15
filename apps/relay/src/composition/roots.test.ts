// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { RelayConfig } from '../config.js';
import type { CompositionKind } from './role-plan.js';
import { createCompositionRoots, type RuntimeFactories } from './roots.js';
import { ROLE_RUNTIME_COMPONENTS, type RuntimeComponent } from './runtime-graph.js';

describe('role composition roots', () => {
  it('dispatches every role to its own injectable runtime factory and dependency trace', async () => {
    const calls: Array<{ kind: CompositionKind; components: readonly RuntimeComponent[] }> = [];
    const factory =
      (kind: CompositionKind) =>
      async (_config: RelayConfig, components: readonly RuntimeComponent[]) => {
        calls.push({ kind, components });
      };
    const roots = createCompositionRoots({
      controller: factory('controller'),
      'source-worker': factory('source-worker'),
      'ingest-origin': factory('ingest-origin'),
      edge: factory('edge'),
      standalone: factory('standalone')
    } satisfies RuntimeFactories);

    for (const kind of [
      'controller',
      'source-worker',
      'ingest-origin',
      'edge',
      'standalone'
    ] as const)
      await roots[kind]({} as RelayConfig);

    expect(calls).toEqual(
      (Object.keys(ROLE_RUNTIME_COMPONENTS) as CompositionKind[]).map((kind) => ({
        kind,
        components: ROLE_RUNTIME_COMPONENTS[kind]
      }))
    );
  });
});
