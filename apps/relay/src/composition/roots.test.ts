// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { RelayConfig } from '../config.js';
import type { CompositionKind } from './role-plan.js';
import { createCompositionRoots, type RuntimeFactories } from './roots.js';

describe('role composition roots', () => {
  it('dispatches every role to its actual injectable runtime factory', async () => {
    const calls: CompositionKind[] = [];
    const factory = (kind: CompositionKind) => async (_config: RelayConfig) => {
      calls.push(kind);
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

    expect(calls).toEqual(['controller', 'source-worker', 'ingest-origin', 'edge', 'standalone']);
  });
});
