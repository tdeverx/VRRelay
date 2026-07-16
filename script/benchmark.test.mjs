// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyBenchmarkGate,
  mediaLines,
  parseArguments,
  redactTarget,
  resolveUrl,
  runBenchmark,
  runBenchmarkCli
} from './benchmark.mjs';

const servers = [];
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe('benchmark CLI helpers', () => {
  it('parses named scenario options without truncating inline URL values', () => {
    const options = parseArguments([
      '--scenario',
      'uncached-encode',
      '--url-template=http://relay.example/play/secret/segment/{i}.ts?token=a=b&scope=vod',
      '--concurrency',
      '2',
      '--requests',
      '5'
    ]);

    expect(options).toMatchObject({
      scenario: 'uncached-encode',
      concurrency: 2,
      requests: 5,
      urlTemplate: 'http://relay.example/play/secret/segment/{i}.ts?token=a=b&scope=vod'
    });
  });

  it('redacts credentials, query values, and opaque playback path segments', () => {
    const redacted = redactTarget(
      'https://user:pass@relay.example/play/super-secret/segment/1.ts?token=abc&foo=bar'
    );

    expect(redacted).not.toContain('super-secret');
    expect(redacted).not.toContain('abc');
    expect(redacted).not.toContain('user');
    expect(redacted).not.toContain('pass');
    expect(redacted).toContain('/play/[REDACTED]');
    expect(redacted).toContain('token=%5BREDACTED%5D');
  });

  it('extracts media lines and resolves relative playlist entries', () => {
    expect(mediaLines('#EXTM3U\n#EXTINF:1,\nseg0.ts\n')).toEqual(['seg0.ts']);
    expect(resolveUrl('https://relay.example/live/index.m3u8', 'seg0.ts')).toBe(
      'https://relay.example/live/seg0.ts'
    );
  });

  it('parses evidence and enforcement options and rejects unknown gates', () => {
    expect(
      parseArguments([
        '--scenario',
        'playlist',
        '--url',
        'https://relay.example/index.m3u8',
        '--output',
        'tmp/report.json',
        '--fail-on-errors',
        '--fail-on-regression',
        '--baseline',
        'tmp/baseline.json',
        '--max-regression-percent',
        '7.5'
      ])
    ).toMatchObject({
      output: 'tmp/report.json',
      failOnErrors: true,
      failOnRegression: true,
      baseline: 'tmp/baseline.json',
      maxRegressionPercent: 7.5
    });

    expect(() =>
      parseArguments([
        '--scenario',
        'playlist',
        '--url',
        'https://relay.example/index.m3u8',
        '--fail-on-error'
      ])
    ).toThrow('Unknown option');
  });

  it('evaluates throughput and p95 regression against comparable retained evidence', () => {
    const baseline = benchmarkReport({ requestsPerSecond: 100, p95: 50 });
    const current = benchmarkReport({ requestsPerSecond: 89, p95: 56 });
    const gated = applyBenchmarkGate(
      current,
      {
        failOnErrors: true,
        failOnRegression: true,
        maxRegressionPercent: 10
      },
      { report: baseline, sha256: 'a'.repeat(64) }
    );

    expect(gated.gate.passed).toBe(false);
    expect(gated.gate.checks).toEqual([
      expect.objectContaining({ name: 'request-errors', passed: true }),
      expect.objectContaining({ name: 'requests-per-second', passed: false, minimum: 90 }),
      expect.objectContaining({ name: 'latency-p95-ms', passed: false, maximum: 55 })
    ]);
    expect(gated.gate.baseline).toEqual({
      sha256: 'a'.repeat(64),
      startedAt: baseline.startedAt,
      maxRegressionPercent: 10
    });
  });

  it('rejects a baseline captured against a different sanitized target', () => {
    const baseline = benchmarkReport({ requestsPerSecond: 100, p95: 50 });
    const current = benchmarkReport({
      requestsPerSecond: 100,
      p95: 50,
      url: 'https://different-relay.example/play/[REDACTED]/index.m3u8'
    });

    expect(() =>
      applyBenchmarkGate(
        current,
        {
          failOnErrors: false,
          failOnRegression: true,
          maxRegressionPercent: 10
        },
        { report: baseline, sha256: 'a'.repeat(64) }
      )
    ).toThrow('Benchmark baseline url does not match the current run.');
  });
});

describe('benchmark scenarios', () => {
  it('fans out a live playlist segment through the load runner', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/live/index.m3u8') {
        response.setHeader('content-type', 'application/vnd.apple.mpegurl');
        response.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nseg0.ts\n');
        return;
      }
      if (request.url === '/live/seg0.ts') {
        response.setHeader('content-type', 'video/mp2t');
        response.end(Buffer.alloc(128, 1));
        return;
      }
      response.statusCode = 404;
      response.end('missing');
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const report = await runBenchmark(
      parseArguments([
        '--scenario',
        'live-fan-out',
        '--url',
        `${baseUrl}/live/index.m3u8`,
        '--concurrency',
        '2',
        '--requests',
        '4',
        '--timeout-ms',
        '1000'
      ])
    );

    expect(report.scenario).toBe('live-fan-out');
    expect(report.result.requests).toBe(4);
    expect(report.result.failures).toBe(0);
    expect(report.result.bytes).toBe(512);
    expect(report.result.statusCounts).toEqual({ 200: 4 });
    expect(report.metadata.command.url).toBe(`${baseUrl}/live/index.m3u8`);
    expect(report.metadata.resources.before.cpu.cores).toBeGreaterThan(0);
  });

  it('retains a failed request-error gate and returns the enforcement exit code', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 503;
      response.end('unavailable');
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-benchmark-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'failed-report.json');
    const stdout = [];

    const exitCode = await runBenchmarkCli(
      [
        '--scenario',
        'playlist',
        '--url',
        `http://127.0.0.1:${address.port}/index.m3u8`,
        '--concurrency',
        '1',
        '--requests',
        '2',
        '--timeout-ms',
        '1000',
        '--fail-on-errors',
        '--output',
        output
      ],
      (value) => stdout.push(value)
    );

    const retained = JSON.parse(await readFile(output, 'utf8'));
    expect(exitCode).toBe(2);
    expect(retained.schemaVersion).toBe(1);
    expect(retained.result.failures).toBe(2);
    expect(retained.gate).toMatchObject({
      enforced: true,
      passed: false,
      checks: [{ name: 'request-errors', passed: false, actual: 2, maximum: 0 }]
    });
    expect(JSON.parse(stdout[0])).toEqual(retained);
    if (process.platform !== 'win32') expect((await stat(output)).mode & 0o777).toBe(0o600);
  });
});

function benchmarkReport({
  requestsPerSecond,
  p95,
  url = 'https://relay.example/play/[REDACTED]/index.m3u8'
}) {
  return {
    schemaVersion: 1,
    scenario: 'playlist',
    startedAt: '2026-07-16T12:00:00.000Z',
    finishedAt: '2026-07-16T12:00:01.000Z',
    metadata: {
      command: {
        scenario: 'playlist',
        requests: 200,
        concurrency: 20,
        timeoutMs: 30_000,
        url
      }
    },
    result: {
      requests: 200,
      concurrency: 20,
      failures: 0,
      requestsPerSecond,
      latencyMs: { p95 }
    }
  };
}
