import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileRevision } from '@vrrelay/domain';
import {
  FFmpegTranscoder,
  ffmpegDecodeAccelerationArgs,
  redactFfmpegError
} from './ffmpeg-transcoder.js';

const execFileAsync = promisify(execFile);
const directories: string[] = [];
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

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('FFmpeg adapter', () => {
  it('delegates automatic hardware decoding to FFmpeg while preserving software opt-out', () => {
    expect(ffmpegDecodeAccelerationArgs('auto')).toEqual(['-hwaccel', 'auto']);
    expect(ffmpegDecodeAccelerationArgs('software')).toEqual([]);
    expect(ffmpegDecodeAccelerationArgs('videotoolbox')).toEqual(['-hwaccel', 'videotoolbox']);
  });

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

  it('stops and awaits the active producer before rethrowing a segment callback failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vrrelay-ffmpeg-callback-'));
    directories.push(directory);
    const fakeFfmpeg = join(directory, 'fake-ffmpeg.cjs');
    const producerDirectory = join(directory, 'producer');
    await writeFile(
      fakeFfmpeg,
      `#!${process.execPath}
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {
  setTimeout(() => {
    writeFileSync('child-exited', 'yes');
    process.exit(0);
  }, 100);
});
setTimeout(() => process.exit(97), 2000);
writeFileSync('segment-0.ts', 'segment');
setInterval(() => {}, 1000);
`
    );
    await chmod(fakeFfmpeg, 0o755);

    const callbackFailure = new Error('Segment callback rejected');
    await expect(
      new FFmpegTranscoder({ ffmpegPath: fakeFfmpeg }).produceVod(
        {
          source: { url: 'fixture', headers: {}, durationSeconds: 60, fingerprint: 'fixture' },
          profile,
          startSegmentIndex: 0,
          startSeconds: 0,
          duration: 60,
          initialReadBurstSeconds: 60
        },
        producerDirectory,
        async () => {
          throw callbackFailure;
        }
      )
    ).rejects.toBe(callbackFailure);
    expect(await readFile(join(producerDirectory, 'child-exited'), 'utf8')).toBe('yes');
  });

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
      'testsrc2=size=320x180:rate=24:duration=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=10',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      source
    ]);
    const transcoder = new FFmpegTranscoder({ ffmpegPath });
    await transcoder.generateSegment(
      {
        source: { url: source, headers: {}, durationSeconds: 10, fingerprint: 'fixture' },
        profile,
        segmentIndex: 0,
        startSeconds: 0,
        duration: 1
      },
      destination
    );

    expect((await stat(destination)).size).toBeGreaterThan(0);

    const produced: number[] = [];
    let producedPath: string | undefined;
    await transcoder.produceVod(
      {
        source: { url: source, headers: {}, durationSeconds: 10, fingerprint: 'fixture' },
        profile,
        startSegmentIndex: 7,
        startSeconds: 8,
        duration: 1,
        initialReadBurstSeconds: 60
      },
      join(directory, 'producer'),
      async (segment) => {
        expect((await stat(segment.path)).size).toBeGreaterThan(0);
        produced.push(segment.index);
        producedPath = segment.path;
      }
    );
    expect(produced).toEqual([7]);

    const firstPacketPts = async (path: string) => {
      const { stderr } = await execFileAsync(ffmpegPath, [
        '-hide_banner',
        '-loglevel',
        'info',
        '-nostdin',
        '-copyts',
        '-i',
        path,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-vf',
        'showinfo',
        '-f',
        'null',
        '-'
      ]);
      const match = stderr.match(/\bpts_time:([+-]?\d+(?:\.\d+)?)/);
      expect(match).not.toBeNull();
      return Number.parseFloat(match?.[1] ?? '');
    };
    expect(await firstPacketPts(producedPath!)).toBeGreaterThanOrEqual(8);

    const fmp4Directory = join(directory, 'producer-fmp4');
    let fmp4Segment: { path: string; initPath?: string } | undefined;
    await transcoder.produceVod(
      {
        source: { url: source, headers: {}, durationSeconds: 10, fingerprint: 'fixture' },
        profile: {
          ...profile,
          delivery: { ...profile.delivery, container: 'mp4', segmentType: 'fmp4' }
        },
        startSegmentIndex: 9,
        startSeconds: 8,
        duration: 1,
        initialReadBurstSeconds: 60
      },
      fmp4Directory,
      async (segment) => {
        fmp4Segment = segment;
      }
    );
    expect(fmp4Segment?.initPath).toBeDefined();
    const joinedFmp4 = join(directory, 'joined.mp4');
    await writeFile(
      joinedFmp4,
      Buffer.concat([await readFile(fmp4Segment!.initPath!), await readFile(fmp4Segment!.path)])
    );
    expect(await firstPacketPts(joinedFmp4)).toBeGreaterThanOrEqual(8);
  }, 20_000);
});
