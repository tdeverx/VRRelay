// SPDX-License-Identifier: GPL-3.0-or-later
import type { RelayConfig } from '../config.js';
import { resolveRolePlan, type CompositionKind } from './role-plan.js';
import {
  startControllerRuntime,
  startEdgeRuntime,
  startIngestOriginRuntime,
  startSourceWorkerRuntime,
  startStandaloneRuntime
} from './runtime.js';

export type CompositionRoot = (config: RelayConfig) => Promise<void>;
export type RoleRuntimeFactory = (config: RelayConfig) => Promise<void>;

export interface RuntimeFactories {
  controller: RoleRuntimeFactory;
  'source-worker': RoleRuntimeFactory;
  'ingest-origin': RoleRuntimeFactory;
  edge: RoleRuntimeFactory;
  standalone: RoleRuntimeFactory;
}

const DEFAULT_RUNTIME_FACTORIES: RuntimeFactories = {
  controller: (config) => startControllerRuntime(config),
  'source-worker': (config) => startSourceWorkerRuntime(config),
  'ingest-origin': (config) => startIngestOriginRuntime(config),
  edge: (config) => startEdgeRuntime(config),
  standalone: (config) => startStandaloneRuntime(config)
};

export function createCompositionRoots(
  factories: RuntimeFactories = DEFAULT_RUNTIME_FACTORIES
): Record<CompositionKind, CompositionRoot> {
  return {
    controller: factories.controller,
    'source-worker': factories['source-worker'],
    'ingest-origin': factories['ingest-origin'],
    edge: factories.edge,
    standalone: factories.standalone
  };
}

export const COMPOSITION_ROOTS = createCompositionRoots();
export const composeController = COMPOSITION_ROOTS.controller;
export const composeSourceWorker = COMPOSITION_ROOTS['source-worker'];
export const composeIngestOrigin = COMPOSITION_ROOTS['ingest-origin'];
export const composeEdge = COMPOSITION_ROOTS.edge;
export const composeStandalone = COMPOSITION_ROOTS.standalone;

export async function composeConfiguredRuntime(config: RelayConfig): Promise<void> {
  const plan = resolveRolePlan(config.nodeRoles);
  await COMPOSITION_ROOTS[plan.kind](config);
}
