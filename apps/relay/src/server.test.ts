// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { loadConfig } from './config.js';
import {
  assertSetupAuthorized,
  liveHlsUpstreamUrl,
  liveOriginSourceUrl,
  meteredReadable,
  redactRequestUrl
} from './server.js';

describe('payload metering', () => {
  it('records chunks that are actually consumed', async () => {
    let bytes = 0;
    const output: Buffer[] = [];
    for await (const chunk of meteredReadable(Readable.from(['hello', ' world']), (size) => {
      bytes += size;
    })) {
      output.push(Buffer.from(chunk));
    }

    expect(Buffer.concat(output).toString()).toBe('hello world');
    expect(bytes).toBe(11);
  });
});

describe('HTTP log redaction', () => {
  it('removes playback and source grants while preserving route context', () => {
    expect(redactRequestUrl('/play/secret-grant/segment/3.ts?cache=1')).toBe(
      '/play/[REDACTED]/segment/3.ts?cache=1'
    );
    expect(redactRequestUrl('/internal/source/source-grant')).toBe('/internal/source/[REDACTED]');
    expect(redactRequestUrl('/api/v1/sessions')).toBe('/api/v1/sessions');
  });
});

describe('first-run setup authorization', () => {
  it('allows setup on a loopback public URL without a token', () => {
    expect(() =>
      assertSetupAuthorized(loadConfig({ VRRELAY_PUBLIC_URL: 'http://127.0.0.1:8099' }), undefined)
    ).not.toThrow();
  });

  it('requires a configured token for remotely reachable setup', () => {
    expect(() =>
      assertSetupAuthorized(
        loadConfig({ VRRELAY_PUBLIC_URL: 'https://relay.example.com' }),
        undefined
      )
    ).toThrow(/VRRELAY_SETUP_TOKEN/);
  });

  it('uses the configured token for remotely reachable setup', () => {
    const token = 'a-secure-bootstrap-token-with-32-characters';
    const config = loadConfig({
      VRRELAY_PUBLIC_URL: 'https://relay.example.com',
      VRRELAY_SETUP_TOKEN: token
    });
    expect(() => assertSetupAuthorized(config, token)).not.toThrow();
    expect(() => assertSetupAuthorized(config, `${token}x`)).toThrow(/invalid/);
  });
});

describe('live edge origin sources', () => {
  it('builds an authenticated SRT reader URL', () => {
    expect(liveOriginSourceUrl('srt://origin.example:8890', 'live-channel_1', 'read-token')).toBe(
      'srt://origin.example:8890?streamid=read:live-channel_1:vrrelay-read:read-token'
    );
  });

  it('keeps SRT encryption material separate from the origin address', () => {
    expect(
      liveOriginSourceUrl(
        'srt://origin.example:8890',
        'live-channel_1',
        'read-token',
        'fixture passphrase'
      )
    ).toBe(
      'srt://origin.example:8890?passphrase=fixture%20passphrase&streamid=read:live-channel_1:vrrelay-read:read-token'
    );
  });

  it('builds an authenticated RTSP reader URL without losing a base path', () => {
    expect(
      liveOriginSourceUrl('rtsp://origin.example:8554/relay', 'live-channel_1', 'read-token')
    ).toBe('rtsp://vrrelay-read:read-token@origin.example:8554/relay/live-channel_1');
  });

  it('rejects unsafe path input', () => {
    expect(() => liveOriginSourceUrl('srt://origin:8890', '../admin', 'read-token')).toThrow(
      /Invalid live path/
    );
  });
});

describe('live HLS proxy targets', () => {
  it('forwards MediaMTX session and low-latency cursor parameters', () => {
    expect(
      liveHlsUpstreamUrl('http://mediamtx:8888', 'live-channel_1', 'main_stream.m3u8', {
        session: 'session-id',
        _HLS_msn: '4',
        token: 'must-not-forward'
      })
    ).toBe('http://mediamtx:8888/live-channel_1/main_stream.m3u8?session=session-id&_HLS_msn=4');
  });

  it('rejects traversal and unsafe live paths', () => {
    expect(() =>
      liveHlsUpstreamUrl('http://mediamtx:8888', 'live-channel_1', '../config', {})
    ).toThrow(/Invalid live HLS resource/);
    expect(() =>
      liveHlsUpstreamUrl('http://mediamtx:8888', '../channel', 'index.m3u8', {})
    ).toThrow(/Invalid live path/);
  });
});
