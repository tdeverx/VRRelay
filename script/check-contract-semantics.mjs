// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AudioSettingsSchema,
  BackendStatusSchema,
  DeliverySettingsSchema,
  NodeCapabilitySchema,
  ProcessingSettingsSchema,
  VideoSettingsSchema
} from '../packages/domain/src/index.ts';
import {
  BackendValidationRequestSchema,
  CreateNodeJoinTokenRequestSchema,
  EnrollNodeRequestSchema,
  RelayEventSchema
} from '../packages/contracts/src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const openapi = await readFile(resolve(root, 'contracts/openapi/vrrelay-v1.yaml'), 'utf8');
const failures = [];

function componentBlock(name) {
  const marker = `    ${name}:\n`;
  const start = openapi.indexOf(marker);
  if (start < 0) throw new Error(`OpenAPI is missing component schema ${name}`);
  const remainder = openapi.slice(start + marker.length);
  const next = remainder.search(/\n    [A-Za-z][A-Za-z0-9]+:\n/);
  return next < 0 ? remainder : remainder.slice(0, next);
}

function yamlList(value) {
  return value
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function openApiRequired(block) {
  const match = /required:\s*\[([\s\S]*?)\]/.exec(block);
  return new Set(match ? yamlList(match[1]) : []);
}

function openApiEnums(block) {
  const enums = new Map();
  for (const [property, definition] of openApiProperties(block)) {
    const inline = /enum:\s*\[([^\]]*)\]/.exec(definition);
    if (inline) {
      enums.set(property, yamlList(inline[1]));
      continue;
    }
    const multiline = /enum:\s*\n((?:\s+-\s+[^\n]+\n?)*)/.exec(definition);
    if (multiline)
      enums.set(
        property,
        multiline[1]
          .split('\n')
          .map((line) => line.replace(/^\s*-\s*/, '').trim())
          .filter(Boolean)
      );
  }
  return enums;
}

function openApiProperties(block) {
  const properties = new Map();
  const marker = '\n      properties:\n';
  const start = block.indexOf(marker);
  if (start < 0) return properties;
  const source = block.slice(start + marker.length);
  const matches = [...source.matchAll(/^        ([A-Za-z][A-Za-z0-9]*):/gm)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    properties.set(
      match[1],
      source.slice(match.index + match[0].length, next?.index ?? source.length)
    );
  }
  return properties;
}

function scalarKeyword(definition, keyword) {
  const quoted = new RegExp(`(?:^|[,{\\n]\\s*)${keyword}:\\s*(['"])([^\\n]*?)\\1`).exec(definition);
  if (quoted) return quoted[2];
  const match = new RegExp(`(?:^|[,{\\n]\\s*)${keyword}:\\s*([^,}\\n]+)`).exec(definition);
  if (!match) return undefined;
  const raw = match[1].trim().replace(/^['"]|['"]$/g, '');
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) && raw !== '' ? numeric : raw;
}

function sorted(values) {
  return [...values].sort();
}

const HTTP_NODE_URL_PATTERN = '^https?://[^/?#@]+(?:/[^?#]*)?$';

for (const [name, schema, propertyOverrides = {}, io = 'output'] of [
  ['VideoSettings', VideoSettingsSchema],
  ['AudioSettings', AudioSettingsSchema],
  ['DeliverySettings', DeliverySettingsSchema],
  ['ProcessingSettings', ProcessingSettingsSchema],
  ['NodeCapability', NodeCapabilitySchema],
  ['BackendStatus', BackendStatusSchema],
  ['BackendValidationRequest', BackendValidationRequestSchema, {}, 'input'],
  ['CreateNodeJoinTokenRequest', CreateNodeJoinTokenRequestSchema, {}, 'input'],
  ['RelayEvent', RelayEventSchema],
  [
    'EnrollNodeRequest',
    EnrollNodeRequestSchema,
    {
      publicUrl: { pattern: HTTP_NODE_URL_PATTERN },
      internalUrl: { pattern: HTTP_NODE_URL_PATTERN }
    },
    'input'
  ]
]) {
  const domain = z.toJSONSchema(schema, { io });
  const block = componentBlock(name);
  const domainRequired = new Set(domain.required ?? []);
  const documentedRequired = openApiRequired(block);
  if (JSON.stringify(sorted(domainRequired)) !== JSON.stringify(sorted(documentedRequired)))
    failures.push(
      `${name} required fields differ: domain=${sorted(domainRequired).join(',')} openapi=${sorted(documentedRequired).join(',')}`
    );

  const documentedAdditionalProperties =
    scalarKeyword(block.slice(0, block.indexOf('\n      properties:')), 'additionalProperties') ??
    true;
  if (Boolean(domain.additionalProperties ?? true) !== Boolean(documentedAdditionalProperties))
    failures.push(
      `${name} additionalProperties differs: domain=${String(
        domain.additionalProperties ?? true
      )} openapi=${String(documentedAdditionalProperties)}`
    );

  const documentedProperties = openApiProperties(block);
  const documentedEnums = openApiEnums(block);
  const domainPropertyNames = Object.keys(domain.properties ?? {});
  if (
    JSON.stringify(sorted(domainPropertyNames)) !==
    JSON.stringify(sorted(documentedProperties.keys()))
  )
    failures.push(
      `${name} properties differ: domain=${sorted(domainPropertyNames).join(',')} openapi=${sorted(documentedProperties.keys()).join(',')}`
    );
  for (const [property, definition] of Object.entries(domain.properties ?? {})) {
    if (typeof definition !== 'object' || definition === null || Array.isArray(definition))
      continue;
    const documented = documentedProperties.get(property);
    if (!documented) {
      failures.push(`${name}.${property} is missing from OpenAPI`);
      continue;
    }
    if ('enum' in definition && Array.isArray(definition.enum)) {
      const expected = definition.enum.map(String);
      const actual = documentedEnums.get(property);
      if (!actual || JSON.stringify(sorted(expected)) !== JSON.stringify(sorted(actual)))
        failures.push(
          `${name}.${property} enum differs: domain=${sorted(expected).join(',')} openapi=${sorted(actual ?? []).join(',')}`
        );
    }
    const expectedDefinition = {
      ...definition,
      ...(propertyOverrides[property] ?? {})
    };
    if (/\$ref:/.test(documented)) continue;
    for (const keyword of [
      'type',
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'pattern',
      'format',
      'default'
    ]) {
      if (!(keyword in expectedDefinition)) continue;
      const expected = expectedDefinition[keyword];
      const actual = scalarKeyword(documented, keyword);
      if (
        keyword === 'pattern' &&
        expectedDefinition.format === 'date-time' &&
        actual === undefined
      )
        continue;
      if (JSON.stringify(expected) !== JSON.stringify(actual))
        failures.push(
          `${name}.${property}.${keyword} differs: domain=${JSON.stringify(
            expected
          )} openapi=${JSON.stringify(actual)}`
        );
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    'OpenAPI media, node, backend-status, enrollment, and event schemas match their runtime validators.'
  );
}
