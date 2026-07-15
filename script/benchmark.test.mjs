// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import {
  mediaLines,
  parseArguments,
  redactTarget,
  resolveUrl,
  runBenchmark
} from './benchmark.mjs';

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
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
});
