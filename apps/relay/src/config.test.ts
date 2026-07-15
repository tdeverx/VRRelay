// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadConfig, parseListenAddress, requiresSetupToken } from './config.js';

describe('relay configuration', () => {
  it('uses and validates the release version override', () => {
    expect(loadConfig({ VRRELAY_VERSION: '1.2.3-rc.1' }).applicationVersion).toBe('1.2.3-rc.1');
    expect(() => loadConfig({ VRRELAY_VERSION: 'v1.2.3' })).toThrow();
  });

  it.each(['false', '0', 'no', 'off', ' FALSE '])(
    'parses the false-like environment value %j as false',
    (value) => {
      const config = loadConfig({
        VRRELAY_TRUST_PROXY: value,
        VRRELAY_MEDIAMTX_ALLOW_INTERNAL_READ: value
      });

      expect(config.trustProxy).toBe(false);
      expect(config.mediaMtxAllowInternalRead).toBe(false);
    }
  );

  it.each(['true', '1', 'yes', 'on', ' TRUE '])(
    'parses the true-like environment value %j as true',
    (value) => {
      const config = loadConfig({
        VRRELAY_TRUST_PROXY: value,
        VRRELAY_MEDIAMTX_ALLOW_INTERNAL_READ: value
      });

      expect(config.trustProxy).toBe(true);
      expect(config.mediaMtxAllowInternalRead).toBe(true);
    }
  );

  it('rejects ambiguous boolean values instead of enabling them', () => {
    expect(() => loadConfig({ VRRELAY_TRUST_PROXY: 'definitely' })).toThrow();
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
    expect(parseListenAddress('[::1]:8100')).toEqual({ host: '[::1]', port: 8100 });
    expect(() => parseListenAddress('127.0.0.1:not-a-port')).toThrow();
    expect(() => parseListenAddress('127.0.0.1:0')).toThrow();
    expect(() => parseListenAddress('127.0.0.1:65536')).toThrow();
  });
});
