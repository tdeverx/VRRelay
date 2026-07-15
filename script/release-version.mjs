// SPDX-License-Identifier: GPL-3.0-or-later
import { pathToFileURL } from 'node:url';

export const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function normalizeReleaseVersion(input) {
  const candidate = String(input ?? '')
    .trim()
    .replace(/^v/, '');
  if (!semanticVersionPattern.test(candidate)) {
    throw new Error(`Expected a semantic release version such as v1.2.3, received: ${input}`);
  }
  return candidate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${normalizeReleaseVersion(process.argv[2])}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
