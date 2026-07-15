// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ManagedMediaMtx, mediaMtxEnvironment } from './media-runtime.js';

describe('native MediaMTX environment', () => {
  it('keeps playback and control listeners private while exposing ingest listeners', () => {
    const environment = mediaMtxEnvironment(8099, {});
    expect(environment.MTX_AUTHHTTPADDRESS).toBe('http://127.0.0.1:8099/internal/mediamtx/auth');
    expect(environment.MTX_APIADDRESS).toBe('127.0.0.1:9997');
    expect(environment.MTX_HLSADDRESS).toBe('127.0.0.1:8888');
    expect(environment.MTX_RTSPADDRESS).toBe('127.0.0.1:8554');
    expect(environment.MTX_RTMPADDRESS).toBe(':1935');
    expect(environment.MTX_SRTADDRESS).toBe(':8890');
    expect(environment.MTX_WEBRTCADDRESS).toBe(':8889');
    expect(environment.MTX_HLSVARIANT).toBe('mpegts');
  });

  it('preserves explicit operator overrides', () => {
    const environment = mediaMtxEnvironment(8099, {
      MTX_HLSADDRESS: '127.0.0.1:18888',
      MTX_WEBRTCADDITIONALHOSTS: 'relay.example.com'
    });
    expect(environment.MTX_HLSADDRESS).toBe('127.0.0.1:18888');
    expect(environment.MTX_WEBRTCADDITIONALHOSTS).toBe('relay.example.com');
  });

  it('does not place relay playback credentials in the callback URL', () => {
    const environment = mediaMtxEnvironment(8099, { VRRELAY_MEDIAMTX_READ_TOKEN: 'secret' });
    expect(environment.MTX_AUTHHTTPADDRESS).not.toContain('secret');
  });

  it('reports an unexpected managed-process exit', async () => {
    const failure = Promise.withResolvers<Error>();
    const runtime = new ManagedMediaMtx({
      executable: process.execPath,
      configPath: fileURLToPath(new URL('test-fixtures/managed-exit.mjs', import.meta.url)),
      relayPort: 8099,
      onUnexpectedExit: failure.resolve
    });
    await runtime.start();
    expect((await failure.promise).message).toContain('23');
  });

  it('does not report an intentional managed-process shutdown', async () => {
    let failure: Error | undefined;
    const runtime = new ManagedMediaMtx({
      executable: process.execPath,
      configPath: fileURLToPath(new URL('test-fixtures/managed-wait.mjs', import.meta.url)),
      relayPort: 8099,
      onUnexpectedExit: (error) => {
        failure = error;
      }
    });
    await runtime.start();
    await runtime.stop();
    expect(failure).toBeUndefined();
  });
});
