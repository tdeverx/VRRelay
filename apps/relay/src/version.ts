// SPDX-License-Identifier: GPL-3.0-or-later
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageVersion = (require('../package.json') as { version: string }).version;

export const SEMANTIC_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function resolveApplicationVersion(value = process.env.VRRELAY_VERSION): string {
  const version = value?.trim() || packageVersion;
  if (!SEMANTIC_VERSION_PATTERN.test(version)) {
    throw new Error(`VRRELAY_VERSION must be a semantic version without a leading v: ${version}`);
  }
  return version;
}

export const APPLICATION_VERSION = resolveApplicationVersion();
