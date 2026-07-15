// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import { z } from 'zod';
import { AgentEnvelopeSchema } from '../packages/contracts/src/agent-protocol.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = resolve(root, 'contracts/events/agent-envelope-v1.schema.json');
const generated = z.toJSONSchema(AgentEnvelopeSchema, {
  target: 'draft-2020-12',
  reused: 'ref'
});
generated.$id = 'https://vrrelay.local/contracts/events/agent-envelope-v1.schema.json';
generated.title = 'AgentEnvelopeV1';
const expected = await format(JSON.stringify(generated), { parser: 'json', printWidth: 100 });

if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8');
  if (current !== expected) {
    console.error(
      'Agent protocol JSON Schema is stale. Run npm run generate:agent-protocol-schema.'
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(target, expected, 'utf8');
}
