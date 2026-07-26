// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  parseListenAddress,
  requiresSetupToken,
  validateRuntimeConfiguration
} from './config.js';

describe('relay configuration', () => {
  it('accepts exact interface listeners and normalizes bracketed IPv6 parsing', () => {
    const current = loadConfig({});
    const configuration = {
      logLevel: 'info' as const,
      listenAddr: '192.0.2.18:8099',
      publicUrl: current.publicUrl,
      adminUrl: current.adminUrl,
      playbackUrl: current.playbackUrl,
      trustedProxyCidrs: current.trustedProxyCidrs,
      viewerRegionHeader: current.viewerRegionHeader,
      agentListenAddr: current.agentListenAddr,
      maxWorkers: current.maxWorkers,
      cacheTtlMs: current.cacheTtlMs,
      cacheLimitBytes: current.cacheLimitBytes,
      vodProducerIdleTimeoutMs: current.vodProducerIdleTimeoutMs,
      vodProducerBufferLowWatermarkMs: current.vodProducerBufferLowWatermarkMs,
      vodProducerBufferHighWatermarkMs: current.vodProducerBufferHighWatermarkMs,
      vodProducerCatchupRate: current.vodProducerCatchupRate,
      vodProducerEncoder: current.vodProducerEncoder,
      vodProducerMaxConcurrent: current.vodProducerMaxConcurrent,
      vodProducerMaxPerProvider: current.vodProducerMaxPerProvider,
      nodeName: current.nodeName,
      nodeRegion: current.nodeRegion
    };
    expect(validateRuntimeConfiguration(current, configuration).listenAddr).toBe('192.0.2.18:8099');
    expect(parseListenAddress('[2001:db8::18]:8099')).toEqual({
      host: '2001:db8::18',
      port: 8099
    });
    expect(() =>
      validateRuntimeConfiguration(current, {
        ...configuration,
        listenAddr: 'relay.example.test:8099'
      })
    ).toThrow(/literal IPv4 or IPv6 address/);
  });

  it('loads allowlisted runtime settings while preserving explicit environment authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-runtime-config-'));
    const path = join(directory, 'runtime.json');
    await writeFile(
      path,
      JSON.stringify({
        listenAddr: '127.0.0.1:9000',
        publicUrl: 'http://127.0.0.1:9000',
        adminUrl: 'http://127.0.0.1:9000',
        playbackUrl: 'http://127.0.0.1:9000',
        trustedProxyCidrs: [],
        viewerRegionHeader: 'x-vrrelay-region',
        agentListenAddr: '127.0.0.1:9100',
        maxWorkers: 4,
        cacheTtlMs: 60_000,
        cacheLimitBytes: 1_000_000,
        vodProducerIdleTimeoutMs: 60_000,
        vodProducerBufferLowWatermarkMs: 30_000,
        vodProducerBufferHighWatermarkMs: 60_000,
        vodProducerCatchupRate: 1.5,
        vodProducerEncoder: 'libx264',
        vodProducerMaxConcurrent: 2,
        vodProducerMaxPerProvider: 2,
        nodeName: 'Configured node',
        nodeRegion: 'studio'
      })
    );
    try {
      expect(loadConfig({ VRRELAY_RUNTIME_CONFIG: path })).toMatchObject({
        listenAddr: '127.0.0.1:9000',
        adminUrl: 'http://127.0.0.1:9000',
        maxWorkers: 4,
        nodeName: 'Configured node'
      });
      expect(
        loadConfig({
          VRRELAY_RUNTIME_CONFIG: path,
          VRRELAY_LISTEN_ADDR: '127.0.0.1:9200',
          VRRELAY_MAX_WORKERS: '2'
        })
      ).toMatchObject({ listenAddr: '127.0.0.1:9200', maxWorkers: 2 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses and validates the release version override', () => {
    expect(loadConfig({ VRRELAY_VERSION: '1.2.3-rc.1' }).applicationVersion).toBe('1.2.3-rc.1');
    expect(() => loadConfig({ VRRELAY_VERSION: 'v1.2.3' })).toThrow();
  });

  it('accepts only explicit trusted-proxy CIDRs and safely migrates the removed boolean switch', () => {
    expect(
      loadConfig({
        VRRELAY_TRUSTED_PROXY_CIDRS: '10.20.0.0/16, fd00:1234::/48'
      }).trustedProxyCidrs
    ).toEqual(['10.20.0.0/16', 'fd00:1234::/48']);
    expect(() => loadConfig({ VRRELAY_TRUSTED_PROXY_CIDRS: '10.20.0.0' })).toThrow(
      /explicit IPv4 or IPv6 CIDR/
    );
    expect(() => loadConfig({ VRRELAY_TRUSTED_PROXY_CIDRS: '10.20.0.0/33' })).toThrow();
    expect(() => loadConfig({ VRRELAY_TRUSTED_PROXY_CIDRS: '0.0.0.0/0' })).toThrow();
    for (const value of ['false', '0', 'no', 'off', ' FALSE '])
      expect(loadConfig({ VRRELAY_TRUST_PROXY: value }).trustedProxyCidrs).toEqual([]);
    for (const value of ['true', '1', 'yes', 'on', 'definitely', ''])
      expect(() => loadConfig({ VRRELAY_TRUST_PROXY: value })).toThrow(
        /VRRELAY_TRUST_PROXY no longer enables proxy trust/
      );
  });

  it('validates regional routing and persistent producer runtime bounds', () => {
    expect(
      loadConfig({
        VRRELAY_VIEWER_REGION_HEADER: 'X-VRRelay-Region',
        VRRELAY_VOD_PRODUCER_IDLE_TIMEOUT: '15s',
        VRRELAY_VOD_PRODUCER_BUFFER_LOW_WATERMARK: '30s',
        VRRELAY_VOD_PRODUCER_BUFFER_HIGH_WATERMARK: '60s',
        VRRELAY_VOD_PRODUCER_CATCHUP_RATE: '1.5',
        VRRELAY_VOD_PRODUCER_ENCODER: 'libx264',
        VRRELAY_VOD_PRODUCER_MAX_CONCURRENT: '4',
        VRRELAY_VOD_PRODUCER_MAX_PER_PROVIDER: '3',
        VRRELAY_LIVE_NORMALIZER_MAX_CONCURRENT: '4',
        VRRELAY_LIVE_NORMALIZER_MAX_PER_OWNER: '2'
      })
    ).toMatchObject({
      viewerRegionHeader: 'x-vrrelay-region',
      vodProducerIdleTimeoutMs: 15_000,
      vodProducerBufferLowWatermarkMs: 30_000,
      vodProducerBufferHighWatermarkMs: 60_000,
      vodProducerCatchupRate: 1.5,
      vodProducerEncoder: 'libx264',
      vodProducerMaxConcurrent: 4,
      vodProducerMaxPerProvider: 3,
      liveNormalizerMaxConcurrent: 4,
      liveNormalizerMaxPerOwner: 2
    });
    expect(() => loadConfig({ VRRELAY_VIEWER_REGION_HEADER: 'invalid header' })).toThrow();
    expect(() => loadConfig({ VRRELAY_VOD_PRODUCER_IDLE_TIMEOUT: '14s' })).toThrow();
    expect(() => loadConfig({ VRRELAY_VOD_PRODUCER_IDLE_TIMEOUT: '601s' })).toThrow();
    expect(() => loadConfig({ VRRELAY_VOD_PRODUCER_MAX_CONCURRENT: '0' })).toThrow();
    expect(() => loadConfig({ VRRELAY_VOD_PRODUCER_MAX_CONCURRENT: '33' })).toThrow();
    expect(() => loadConfig({ VRRELAY_VOD_PRODUCER_MAX_PER_PROVIDER: '0' })).toThrow();
    expect(() => loadConfig({ VRRELAY_VOD_PRODUCER_CATCHUP_RATE: '0.9' })).toThrow();
    expect(() => loadConfig({ VRRELAY_VOD_PRODUCER_CATCHUP_RATE: '2.1' })).toThrow();
    expect(() => loadConfig({ VRRELAY_VOD_PRODUCER_ENCODER: 'h264_not_real' })).toThrow();
    expect(() =>
      loadConfig({
        VRRELAY_LIVE_NORMALIZER_MAX_CONCURRENT: '1',
        VRRELAY_LIVE_NORMALIZER_MAX_PER_OWNER: '2'
      })
    ).toThrow(/Per-owner live normalizer capacity/);
    expect(() =>
      loadConfig({
        VRRELAY_VOD_PRODUCER_BUFFER_LOW_WATERMARK: '60s',
        VRRELAY_VOD_PRODUCER_BUFFER_HIGH_WATERMARK: '30s'
      })
    ).toThrow(/high watermark must be greater/);
  });

  it('accepts normal dashboard levels and standard operational environment levels', () => {
    expect(loadConfig({ VRRELAY_LOG_LEVEL: 'info' }).logLevel).toBe('info');
    expect(loadConfig({ VRRELAY_LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
    expect(loadConfig({ VRRELAY_LOG_LEVEL: 'warn' }).logLevel).toBe('warn');
    expect(loadConfig({ VRRELAY_LOG_LEVEL: 'silent' }).logLevel).toBe('silent');
    expect(() => loadConfig({ VRRELAY_LOG_LEVEL: 'verbose' })).toThrow();
  });

  it.each(['false', '0', 'no', 'off', ' FALSE '])(
    'parses the false-like MediaMTX environment value %j as false',
    (value) => {
      expect(
        loadConfig({ VRRELAY_MEDIAMTX_ALLOW_INTERNAL_READ: value }).mediaMtxAllowInternalRead
      ).toBe(false);
    }
  );

  it.each(['true', '1', 'yes', 'on', ' TRUE '])(
    'parses the true-like MediaMTX environment value %j as true',
    (value) => {
      expect(
        loadConfig({ VRRELAY_MEDIAMTX_ALLOW_INTERNAL_READ: value }).mediaMtxAllowInternalRead
      ).toBe(true);
    }
  );

  it('rejects ambiguous MediaMTX boolean values instead of enabling them', () => {
    expect(() => loadConfig({ VRRELAY_MEDIAMTX_ALLOW_INTERNAL_READ: 'definitely' })).toThrow();
  });

  it('requires secure public surfaces, explicit proxies, and non-default secrets in production', () => {
    const production = {
      VRRELAY_ENVIRONMENT: 'production',
      VRRELAY_PUBLIC_URL: 'https://relay.example.test',
      VRRELAY_ADMIN_URL: 'https://admin.example.test',
      VRRELAY_PLAYBACK_URL: 'https://play.example.test',
      VRRELAY_TRUSTED_PROXY_CIDRS: '10.20.0.0/16',
      VRRELAY_MEDIAMTX_READ_TOKEN: 'm'.repeat(32)
    };
    expect(loadConfig(production)).toMatchObject({
      environment: 'production',
      publicUrl: 'https://relay.example.test',
      adminUrl: 'https://admin.example.test',
      playbackUrl: 'https://play.example.test',
      trustedProxyCidrs: ['10.20.0.0/16']
    });
    expect(() =>
      loadConfig({ ...production, VRRELAY_ADMIN_URL: 'http://admin.example.test' })
    ).toThrow(/must use HTTPS/);
    expect(() => loadConfig({ ...production, VRRELAY_TRUSTED_PROXY_CIDRS: '' })).toThrow(
      /explicit trusted-proxy CIDR/
    );
    expect(() =>
      loadConfig({ ...production, VRRELAY_MEDIAMTX_READ_TOKEN: 'development-read-token-change-me' })
    ).toThrow(/default or placeholder/);
    expect(() =>
      loadConfig({
        ...production,
        VRRELAY_POSTGRES_URL: 'postgresql://vrrelay:change-me@postgres.internal/vrrelay'
      })
    ).toThrow(/placeholder passwords/);
  });

  it('requires HTTPS enrollment and WSS transport for production data-plane nodes', () => {
    const productionWorker = {
      VRRELAY_ENVIRONMENT: 'production',
      VRRELAY_PUBLIC_URL: 'https://source.example.test',
      VRRELAY_ADMIN_URL: 'https://source.example.test',
      VRRELAY_PLAYBACK_URL: 'https://source.example.test',
      VRRELAY_TRUSTED_PROXY_CIDRS: '10.20.0.0/16',
      VRRELAY_MEDIAMTX_READ_TOKEN: 'm'.repeat(32),
      VRRELAY_NODE_ROLES: 'source-worker'
    };
    expect(() => loadConfig(productionWorker)).toThrow(/enrollment URL/);
    expect(() =>
      loadConfig({
        ...productionWorker,
        VRRELAY_CONTROLLER_ENROLLMENT_URL: 'http://controller.example.test/enroll',
        VRRELAY_CONTROLLER_AGENT_URL: 'ws://controller.example.test/agent'
      })
    ).toThrow(/must use HTTPS/);
    expect(
      loadConfig({
        ...productionWorker,
        VRRELAY_CONTROLLER_ENROLLMENT_URL: 'https://controller.example.test/enroll',
        VRRELAY_CONTROLLER_AGENT_URL: 'wss://controller.example.test/agent'
      })
    ).toMatchObject({
      controllerEnrollmentUrl: 'https://controller.example.test/enroll',
      controllerAgentUrl: 'wss://controller.example.test/agent'
    });

    expect(() =>
      loadConfig({ ...productionWorker, VRRELAY_NODE_ROLES: 'source-worker,edge' })
    ).toThrow(/enrollment URL/);
    expect(
      loadConfig({
        ...productionWorker,
        VRRELAY_NODE_ROLES: 'source-worker,edge',
        VRRELAY_CONTROLLER_ENROLLMENT_URL: 'https://controller.example.test/enroll',
        VRRELAY_CONTROLLER_AGENT_URL: 'wss://controller.example.test/agent'
      }).nodeRoles
    ).toEqual(['source-worker', 'edge']);
  });

  it('requires both managed MediaMTX paths or neither', () => {
    expect(() => loadConfig({ VRRELAY_MEDIAMTX_EXECUTABLE: '/runtime/mediamtx' })).toThrow(
      /must be configured together/
    );
    expect(() => loadConfig({ VRRELAY_MEDIAMTX_CONFIG: '/runtime/mediamtx.yml' })).toThrow(
      /must be configured together/
    );
    expect(
      loadConfig({
        VRRELAY_MEDIAMTX_EXECUTABLE: '/runtime/mediamtx',
        VRRELAY_MEDIAMTX_CONFIG: '/runtime/mediamtx.yml'
      }).mediaMtxConfig
    ).toBe('/runtime/mediamtx.yml');
  });

  it('parses PostgreSQL migration backup configuration', () => {
    expect(loadConfig({}).pgDumpPath).toBe('pg_dump');
    expect(loadConfig({}).pgDumpTimeoutMs).toBe(30 * 60_000);
    const configured = loadConfig({
      VRRELAY_PG_DUMP: '/opt/postgresql/bin/pg_dump',
      VRRELAY_PG_DUMP_TIMEOUT: '45s'
    });
    expect(configured.pgDumpPath).toBe('/opt/postgresql/bin/pg_dump');
    expect(configured.pgDumpTimeoutMs).toBe(45_000);
    expect(() => loadConfig({ VRRELAY_PG_DUMP_TIMEOUT: 'forever' })).toThrow(
      'Expected duration like 30m, 10s, or 1h'
    );
  });

  it('parses bounded agent log retention controls', () => {
    expect(loadConfig({})).toMatchObject({
      agentLogRetentionRows: 1000,
      agentLogQueryLimit: 200,
      jobLogRetentionRows: 1000,
      jobLogQueryLimit: 200
    });
    expect(
      loadConfig({
        VRRELAY_AGENT_LOG_RETENTION_ROWS: '2500',
        VRRELAY_AGENT_LOG_QUERY_LIMIT: '500',
        VRRELAY_JOB_LOG_RETENTION_ROWS: '3000',
        VRRELAY_JOB_LOG_QUERY_LIMIT: '400'
      })
    ).toMatchObject({
      agentLogRetentionRows: 2500,
      agentLogQueryLimit: 500,
      jobLogRetentionRows: 3000,
      jobLogQueryLimit: 400
    });
    expect(() => loadConfig({ VRRELAY_AGENT_LOG_RETENTION_ROWS: '99' })).toThrow();
    expect(() => loadConfig({ VRRELAY_AGENT_LOG_QUERY_LIMIT: '1001' })).toThrow();
    expect(() => loadConfig({ VRRELAY_JOB_LOG_RETENTION_ROWS: '99' })).toThrow();
    expect(() => loadConfig({ VRRELAY_JOB_LOG_QUERY_LIMIT: '1001' })).toThrow();
  });

  it('treats blank optional environment values as unset', () => {
    const config = loadConfig({
      VRRELAY_SETUP_TOKEN: '',
      VRRELAY_MASTER_KEY: '   ',
      VRRELAY_MEDIAMTX_EXECUTABLE: '',
      VRRELAY_MEDIAMTX_CONFIG: '',
      VRRELAY_LIVE_ORIGIN_URL: '',
      VRRELAY_LIVE_SRT_PASSPHRASE: '',
      VRRELAY_METRICS_TOKEN: '',
      VRRELAY_CONTROLLER_AGENT_URL: '',
      VRRELAY_CONTROLLER_ENROLLMENT_URL: '',
      VRRELAY_NODE_JOIN_TOKEN: '',
      VRRELAY_POSTGRES_URL: '',
      VRRELAY_VALKEY_URL: '',
      VRRELAY_S3_ENDPOINT: '',
      VRRELAY_AZURE_ACCOUNT_URL: ''
    });

    expect(config.setupToken).toBeUndefined();
    expect(config.masterKey).toBeUndefined();
    expect(config.liveOriginUrl).toBeUndefined();
    expect(config.liveOriginSrtPassphrase).toBeUndefined();
    expect(config.controllerAgentUrl).toBeUndefined();
    expect(config.s3Endpoint).toBeUndefined();
  });

  it('loads the checked-in environment template when blank values are unchanged', () => {
    const environment = Object.fromEntries(
      readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );

    expect(() => loadConfig(environment)).not.toThrow();
  });

  it.each(['http://localhost:8099', 'http://127.0.0.1:8099', 'http://[::1]:8099'])(
    'allows local first-run setup without a bootstrap token for %s',
    (url) => expect(requiresSetupToken(url)).toBe(false)
  );

  it.each(['https://relay.example.com', 'http://192.168.1.20:8099', 'http://controller:8099'])(
    'requires a first-run bootstrap token for remotely reachable URL %s',
    (url) => expect(requiresSetupToken(url)).toBe(true)
  );

  it('accepts only supported live-origin transports and valid SRT passphrase lengths', () => {
    expect(
      loadConfig({
        VRRELAY_LIVE_ORIGIN_URL: 'srt://origin.example.com:8890',
        VRRELAY_LIVE_SRT_PASSPHRASE: 'a-secure-passphrase'
      }).liveOriginSrtPassphrase
    ).toBe('a-secure-passphrase');
    expect(() => loadConfig({ VRRELAY_LIVE_ORIGIN_URL: 'https://origin.example.com' })).toThrow();
    expect(() => loadConfig({ VRRELAY_LIVE_SRT_PASSPHRASE: 'short' })).toThrow();
    expect(loadConfig({ VRRELAY_LIVE_SRT_PASSPHRASE: '' }).liveOriginSrtPassphrase).toBeUndefined();
  });

  it('validates listen addresses before passing them to the network server', () => {
    expect(parseListenAddress('127.0.0.1:8099')).toEqual({ host: '127.0.0.1', port: 8099 });
    expect(parseListenAddress('[::1]:8100')).toEqual({ host: '::1', port: 8100 });
    expect(() => parseListenAddress('127.0.0.1:not-a-port')).toThrow();
    expect(() => parseListenAddress('127.0.0.1:0')).toThrow();
    expect(() => parseListenAddress('127.0.0.1:65536')).toThrow();
  });
});
