import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileRevision } from '@vrrelay/domain';
import { FFmpegTranscoder, redactFfmpegError } from './ffmpeg-transcoder.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('FFmpeg adapter', () => {
  it('redacts internal grants, credentials, and source URLs from FFmpeg failures', () => {
    const sensitive = [
      'Authorization: MediaBrowser Client="VRRelay", Token="provider-secret"',
      'X-Emby-Token: provider-secret',
      'Unable to open http://127.0.0.1:8099/internal/source/loopback-grant?token=query-secret',
      'Input https://jellyfin.private.example/Videos/item/stream?api_key=provider-secret failed',
      'srt://origin.private.example:8890?passphrase=srt-secret&streamid=read:path:user:token'
    ].join('\n');
    const redacted = redactFfmpegError(sensitive);
    expect(redacted).not.toContain('provider-secret');
    expect(redacted).not.toContain('loopback-grant');
    expect(redacted).not.toContain('query-secret');
    expect(redacted).not.toContain('srt-secret');
    expect(redacted).not.toContain('jellyfin.private.example');
    expect(redacted).not.toContain('origin.private.example');
    expect(redacted).toContain('[REDACTED_HEADER]');
    expect(redacted).toContain('[REDACTED_URL]');
  });

  it('discovers the installed executable without a fake writable stream', async () => {
    const capabilities = await new FFmpegTranscoder({
      ffmpegPath: process.env.VRRELAY_FFMPEG ?? 'ffmpeg'
    }).discover();
    expect(capabilities.ffmpegVersion).toMatch(/^ffmpeg version/i);
    expect(
      capabilities.encoders.some((encoder) => encoder.codec === 'h264' && encoder.available)
    ).toBe(true);
    expect(capabilities.muxers).toContain('mpegts');
  }, 20_000);

  it('encodes a real MPEG-TS segment with the structured filter graph', async () => {
    const ffmpegPath = process.env.VRRELAY_FFMPEG ?? 'ffmpeg';
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-ffmpeg-'));
    directories.push(directory);
    const source = join(directory, 'source.mp4');
    const destination = join(directory, 'segment.ts');
    await execFileAsync(ffmpegPath, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24:duration=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      source
    ]);
    const profile: ProfileRevision = {
      profileId: 'test-h264',
      revision: 1,
      name: 'Test H.264',
      description: 'Runtime test profile',
      platform: 'pc',
      state: 'experimental',
      video: {
        codec: 'h264',
        encoder: 'libx264',
        hardwareMode: 'software',
        decodeMode: 'auto',
        profile: 'high',
        level: '4.1',
        pixelFormat: 'yuv420p',
        width: 320,
        height: 180,
        frameRate: 24,
        bitrateKbps: 600,
        maxrateKbps: 700,
        bufferKbps: 1_400,
        preset: 'ultrafast',
        gop: 48,
        bFrames: 0
      },
      audio: { codec: 'aac', channels: 2, layout: 'stereo', sampleRate: 48_000, bitrateKbps: 96 },
      delivery: {
        method: 'hls',
        container: 'mpegts',
        segmentType: 'mpegts',
        segmentDuration: 1,
        playlistType: 'vod',
        latencyMode: 'standard'
      },
      processing: { toneMap: false, burnSubtitles: false, passthrough: 'never', maxWorkers: 1 },
      createdAt: new Date().toISOString()
    };

    await new FFmpegTranscoder({ ffmpegPath }).generateSegment(
      {
        source: { url: source, headers: {}, durationSeconds: 1, fingerprint: 'fixture' },
        profile,
        segmentIndex: 0,
        startSeconds: 0,
        duration: 1
      },
      destination
    );

    expect((await stat(destination)).size).toBeGreaterThan(0);
  }, 20_000);
});
