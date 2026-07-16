#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { cpus, freemem, loadavg, platform, release, totalmem, type, arch } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const SCENARIOS = new Set([
  'playlist',
  'cached-egress',
  'uncached-encode',
  'live-fan-out',
  'cache-ratio',
  'resource-snapshot'
]);

const DEFAULT_CONCURRENCY = 20;
const DEFAULT_REQUESTS = 200;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REGRESSION_PERCENT = 10;
const REPORT_SCHEMA_VERSION = 1;
const BOOLEAN_OPTIONS = new Set(['failOnErrors', 'failOnRegression']);
const VALUE_OPTIONS = new Set([
  'scenario',
  'url',
  'urlTemplate',
  'concurrency',
  'requests',
  'timeoutMs',
  'hotRatio',
  'output',
  'baseline',
  'maxRegressionPercent'
]);

export function usage() {
  return `Usage:
  node script/benchmark.mjs --scenario playlist --url <playlist-url> [--concurrency 20 --requests 200]
  node script/benchmark.mjs --scenario cached-egress --url <segment-url>
  node script/benchmark.mjs --scenario uncached-encode --url-template '<segment-url-with-{i}>'
  node script/benchmark.mjs --scenario live-fan-out --url <live-media-playlist-url>
  node script/benchmark.mjs --scenario cache-ratio --url <hot-segment-url> --url-template '<cold-url-with-{i}>' [--hot-ratio 0.8]
  node script/benchmark.mjs --scenario resource-snapshot

Evidence and enforcement options:
  --output <report.json>             Retain the complete sanitized JSON report
  --fail-on-errors                   Exit 2 when any request or transport error occurs
  --fail-on-regression               Exit 2 when throughput or p95 regresses from --baseline
  --baseline <report.json>           Schema-compatible baseline for regression checks
  --max-regression-percent <number>  Allowed throughput/p95 change (default: 10)

Legacy mode is still accepted:
  node script/benchmark.mjs <playlist-or-segment-url> [concurrency] [requests]`;
}

export function parseArguments(argv) {
  if (argv[0] && !argv[0].startsWith('-')) {
    return normalizeOptions({
      scenario: 'playlist',
      url: argv[0],
      concurrency: argv[1] ?? DEFAULT_CONCURRENCY,
      requests: argv[2] ?? DEFAULT_REQUESTS
    });
  }

  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`Unexpected argument: ${item}\n\n${usage()}`);
    const equalsIndex = item.indexOf('=');
    const rawKey = equalsIndex === -1 ? item.slice(2) : item.slice(2, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : item.slice(equalsIndex + 1);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = inlineValue === undefined ? true : booleanValue(inlineValue, rawKey);
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new Error(`Unknown option: --${rawKey}\n\n${usage()}`);
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing value for --${rawKey}\n\n${usage()}`);
    if (inlineValue === undefined) index += 1;
    options[key] = value;
  }
  return normalizeOptions(options);
}

function normalizeOptions(input) {
  const scenario = input.scenario ?? 'playlist';
  if (!SCENARIOS.has(scenario))
    throw new Error(`Unknown benchmark scenario "${scenario}".\n\n${usage()}`);
  const requestedConcurrency = positiveInteger(
    input.concurrency ?? DEFAULT_CONCURRENCY,
    'concurrency'
  );
  const requestedRequests = positiveInteger(input.requests ?? DEFAULT_REQUESTS, 'requests');
  const concurrency = scenario === 'resource-snapshot' ? 0 : requestedConcurrency;
  const requests = scenario === 'resource-snapshot' ? 0 : Math.max(concurrency, requestedRequests);
  const timeoutMs = positiveInteger(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const hotRatio = boundedRatio(input.hotRatio ?? 0.8);
  const failOnErrors = Boolean(input.failOnErrors);
  const failOnRegression = Boolean(input.failOnRegression);
  const maxRegressionPercent = percentage(
    input.maxRegressionPercent ?? DEFAULT_MAX_REGRESSION_PERCENT,
    'max-regression-percent'
  );
  const options = {
    scenario,
    concurrency,
    requests,
    timeoutMs,
    hotRatio,
    failOnErrors,
    failOnRegression,
    maxRegressionPercent,
    ...(input.url ? { url: String(input.url) } : {}),
    ...(input.urlTemplate ? { urlTemplate: String(input.urlTemplate) } : {}),
    ...(input.output ? { output: String(input.output) } : {}),
    ...(input.baseline ? { baseline: String(input.baseline) } : {})
  };

  if (scenario !== 'resource-snapshot' && !options.url && !options.urlTemplate)
    throw new Error(`Scenario "${scenario}" requires --url or --url-template.\n\n${usage()}`);
  if (['uncached-encode', 'cache-ratio'].includes(scenario)) {
    if (!options.urlTemplate)
      throw new Error(`Scenario "${scenario}" requires --url-template with a {i} placeholder.`);
    if (!/\{i\}|\{n\}/.test(options.urlTemplate))
      throw new Error('--url-template must contain a {i} or {n} placeholder.');
  }
  if (scenario === 'cache-ratio' && !options.url)
    throw new Error('Scenario "cache-ratio" requires --url for the hot cached target.');
  if (['playlist', 'cached-egress', 'live-fan-out'].includes(scenario) && !options.url)
    throw new Error(`Scenario "${scenario}" requires --url.`);
  if (failOnRegression && !options.baseline)
    throw new Error('--fail-on-regression requires --baseline.');
  if (!failOnRegression && options.baseline)
    throw new Error('--baseline requires --fail-on-regression.');
  if (!failOnRegression && input.maxRegressionPercent !== undefined)
    throw new Error('--max-regression-percent requires --fail-on-regression.');
  if (scenario === 'resource-snapshot' && failOnRegression)
    throw new Error('The resource-snapshot scenario cannot use a regression gate.');
  return options;
}

function booleanValue(value, label) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} must be true or false when assigned a value`);
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function boundedRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1)
    throw new Error('hot-ratio must be greater than 0 and less than 1');
  return parsed;
}

function percentage(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100)
    throw new Error(`${label} must be a number from 0 through 100`);
  return parsed;
}

export function mediaLines(playlist) {
  return playlist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function resolveUrl(baseUrl, maybeRelative) {
  return new URL(maybeRelative, baseUrl).toString();
}

export function targetFromTemplate(template, index) {
  return template.replaceAll('{i}', String(index)).replaceAll('{n}', String(index));
}

export function redactTarget(value) {
  const normalized = value.replaceAll('{i}', '0').replaceAll('{n}', '0');
  try {
    const url = new URL(normalized);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]');
    url.pathname = url.pathname
      .replace(/\/play\/[^/]+/g, '/play/[REDACTED]')
      .replace(/\/internal\/source\/[^/]+/g, '/internal/source/[REDACTED]');
    return url.toString();
  } catch {
    return '[unparseable-target]';
  }
}

async function fetchBytes(url, timeoutMs) {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.arrayBuffer();
  return { ok: response.ok, status: response.status, bytes: body.byteLength };
}

async function resolveLiveSegment(url, timeoutMs) {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`Live playlist returned HTTP ${response.status}`);
  const playlist = await response.text();
  const first = mediaLines(playlist)[0];
  if (!first) throw new Error('Live playlist did not contain a media segment');
  return resolveUrl(url, first);
}

export async function runBenchmark(options) {
  const startedAt = new Date().toISOString();
  const resourcesBefore = resourceSnapshot();
  if (options.scenario === 'resource-snapshot') {
    return {
      schemaVersion: REPORT_SCHEMA_VERSION,
      scenario: options.scenario,
      startedAt,
      finishedAt: new Date().toISOString(),
      metadata: metadata(options, resourcesBefore, resourceSnapshot()),
      result: {
        requests: 0,
        concurrency: 0,
        failures: 0,
        seconds: 0,
        requestsPerSecond: 0,
        mebibytesPerSecond: 0,
        latencyMs: {}
      }
    };
  }

  let makeUrl;
  if (options.scenario === 'playlist') {
    makeUrl = () => options.url;
  } else if (options.scenario === 'cached-egress') {
    await fetchBytes(options.url, options.timeoutMs);
    makeUrl = () => options.url;
  } else if (options.scenario === 'uncached-encode') {
    makeUrl = (index) => targetFromTemplate(options.urlTemplate, index);
  } else if (options.scenario === 'live-fan-out') {
    const segmentUrl = await resolveLiveSegment(options.url, options.timeoutMs);
    makeUrl = () => segmentUrl;
  } else if (options.scenario === 'cache-ratio') {
    makeUrl = (index) =>
      (index % 100) / 100 < options.hotRatio
        ? options.url
        : targetFromTemplate(options.urlTemplate, index);
  } else {
    throw new Error(`Unhandled scenario: ${options.scenario}`);
  }

  const result = await load(makeUrl, options);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    scenario: options.scenario,
    startedAt,
    finishedAt: new Date().toISOString(),
    metadata: metadata(options, resourcesBefore, resourceSnapshot()),
    result
  };
}

export async function readBenchmarkBaseline(file) {
  const serialized = await readFile(file, 'utf8');
  let report;
  try {
    report = JSON.parse(serialized);
  } catch {
    throw new Error('Benchmark baseline is not valid JSON.');
  }
  validateBaselineReport(report);
  return {
    report,
    sha256: createHash('sha256').update(serialized).digest('hex')
  };
}

function validateBaselineReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report))
    throw new Error('Benchmark baseline must contain a JSON object.');
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION)
    throw new Error(`Benchmark baseline must use schemaVersion ${REPORT_SCHEMA_VERSION}.`);
  if (typeof report.scenario !== 'string' || !report.metadata?.command || !report.result)
    throw new Error('Benchmark baseline is missing scenario, command metadata, or result data.');
  for (const [label, value] of [
    ['failures', report.result.failures],
    ['requestsPerSecond', report.result.requestsPerSecond],
    ['latencyMs.p95', report.result.latencyMs?.p95]
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new Error(`Benchmark baseline has an invalid ${label} value.`);
  }
  if (report.result.failures !== 0)
    throw new Error('Benchmark baseline cannot contain failed requests.');
}

export function applyBenchmarkGate(report, options, baseline) {
  const checks = [];
  if (options.failOnErrors) {
    checks.push({
      name: 'request-errors',
      passed: report.result.failures === 0,
      actual: report.result.failures,
      maximum: 0
    });
  }

  let baselineMetadata;
  if (options.failOnRegression) {
    if (!baseline) throw new Error('A loaded benchmark baseline is required.');
    assertComparableBaseline(report, baseline.report);
    const allowance = options.maxRegressionPercent / 100;
    const minimumRequestsPerSecond = roundedMetric(
      baseline.report.result.requestsPerSecond * (1 - allowance)
    );
    const maximumP95Ms = roundedMetric(baseline.report.result.latencyMs.p95 * (1 + allowance));
    checks.push(
      {
        name: 'requests-per-second',
        passed: report.result.requestsPerSecond >= minimumRequestsPerSecond,
        actual: report.result.requestsPerSecond,
        minimum: minimumRequestsPerSecond,
        baseline: baseline.report.result.requestsPerSecond
      },
      {
        name: 'latency-p95-ms',
        passed: report.result.latencyMs.p95 <= maximumP95Ms,
        actual: report.result.latencyMs.p95,
        maximum: maximumP95Ms,
        baseline: baseline.report.result.latencyMs.p95
      }
    );
    baselineMetadata = {
      sha256: baseline.sha256,
      startedAt: baseline.report.startedAt,
      maxRegressionPercent: options.maxRegressionPercent
    };
  }

  return {
    ...report,
    gate: {
      enforced: checks.length > 0,
      passed: checks.every((check) => check.passed),
      checks,
      ...(baselineMetadata ? { baseline: baselineMetadata } : {})
    }
  };
}

function roundedMetric(value) {
  return Number(value.toPrecision(12));
}

function assertComparableBaseline(report, baseline) {
  const currentCommand = report.metadata.command;
  const baselineCommand = baseline.metadata.command;
  for (const field of ['scenario', 'requests', 'concurrency', 'timeoutMs', 'url', 'urlTemplate']) {
    if (currentCommand[field] !== baselineCommand[field])
      throw new Error(`Benchmark baseline ${field} does not match the current run.`);
  }
  if (
    currentCommand.scenario === 'cache-ratio' &&
    currentCommand.hotRatio !== baselineCommand.hotRatio
  )
    throw new Error('Benchmark baseline hotRatio does not match the current run.');
}

export async function writeBenchmarkReport(file, report) {
  const destination = resolve(file);
  const directory = dirname(destination);
  const temporary = `${directory}/.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function load(makeUrl, options) {
  let next = 0;
  let bytes = 0;
  let failures = 0;
  const statusCounts = {};
  const latencies = [];
  const started = performance.now();

  await Promise.all(
    Array.from({ length: options.concurrency }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= options.requests) break;
        const before = performance.now();
        try {
          const response = await fetchBytes(makeUrl(index), options.timeoutMs);
          statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;
          if (!response.ok) failures += 1;
          bytes += response.bytes;
        } catch {
          failures += 1;
          statusCounts.error = (statusCounts.error ?? 0) + 1;
        }
        latencies.push(performance.now() - before);
      }
    })
  );

  latencies.sort((left, right) => left - right);
  const elapsed = (performance.now() - started) / 1000;
  return {
    requests: options.requests,
    concurrency: options.concurrency,
    failures,
    bytes,
    statusCounts,
    seconds: elapsed,
    requestsPerSecond: options.requests / elapsed,
    mebibytesPerSecond: bytes / 1_048_576 / elapsed,
    latencyMs: {
      min: percentile(latencies, 0),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      max: percentile(latencies, 1)
    }
  };
}

function percentile(values, value) {
  if (!values.length) return undefined;
  return values[Math.min(values.length - 1, Math.floor(values.length * value))];
}

function metadata(options, resourcesBefore, resourcesAfter) {
  return {
    command: {
      scenario: options.scenario,
      requests: options.requests,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      ...(options.scenario === 'cache-ratio' ? { hotRatio: options.hotRatio } : {}),
      ...(options.url ? { url: redactTarget(options.url) } : {}),
      ...(options.urlTemplate ? { urlTemplate: redactTarget(options.urlTemplate) } : {})
    },
    runtime: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      os: type(),
      release: release()
    },
    resources: {
      before: resourcesBefore,
      after: resourcesAfter
    },
    interpretation:
      'Benchmark results are scenario evidence for this environment only; they are not a universal viewer limit.'
  };
}

export function resourceSnapshot() {
  const cpuList = cpus();
  return {
    cpu: {
      model: cpuList[0]?.model ?? 'unknown',
      cores: cpuList.length,
      loadAverage: loadavg()
    },
    memory: {
      totalBytes: totalmem(),
      freeBytes: freemem()
    },
    gpu: gpuSnapshot()
  };
}

function gpuSnapshot() {
  const nvidia = spawnSync(
    'nvidia-smi',
    ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
    { encoding: 'utf8', timeout: 2000 }
  );
  if (nvidia.status === 0 && nvidia.stdout.trim()) {
    return nvidia.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const [name, utilizationPercent, memoryUsedMiB, memoryTotalMiB] = line
          .split(',')
          .map((value) => value.trim());
        return {
          name,
          utilizationPercent: Number(utilizationPercent),
          memoryUsedMiB: Number(memoryUsedMiB),
          memoryTotalMiB: Number(memoryTotalMiB)
        };
      });
  }
  const mac = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'], {
    encoding: 'utf8',
    timeout: 5000
  });
  if (mac.status === 0 && mac.stdout.trim()) {
    try {
      const payload = JSON.parse(mac.stdout);
      return (payload.SPDisplaysDataType ?? []).map((item) => ({
        name: item.sppci_model ?? item._name ?? 'unknown',
        vendor: item.spdisplays_vendor ?? item.spdisplays_vendor_id,
        vram: item.spdisplays_vram
      }));
    } catch {
      return [];
    }
  }
  return [];
}

export async function runBenchmarkCli(argv, stdout = console.log) {
  const options = parseArguments(argv);
  const baseline = options.baseline ? await readBenchmarkBaseline(options.baseline) : undefined;
  const result = applyBenchmarkGate(await runBenchmark(options), options, baseline);
  if (options.output) await writeBenchmarkReport(options.output, result);
  stdout(JSON.stringify(result, null, 2));
  return result.gate.passed ? 0 : 2;
}

async function main() {
  process.exitCode = await runBenchmarkCli(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
