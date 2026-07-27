import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@vrrelay/domain';
import { FFmpegLiveNormalizer, liveNormalizerArgs } from './ffmpeg-live-normalizer.js';

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

describe('FFmpeg live normalizer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds the live normalization command from the selected profile', () => {
    const profile: Profile = {
      profileId: 'live-720p60',
      name: 'Live 720p60',
      platform: 'pc',
      state: 'experimental',
      video: {
        codec: 'h264',
        decodeMode: 'auto',
        profile: 'high',
        level: '4.1',
        pixelFormat: 'yuv420p',
        width: 1280,
        height: 720,
        frameRate: 60,
        bitrateKbps: 5_000,
        maxrateKbps: 5_500,
        bufferKbps: 11_000,
        preset: 'veryfast',
        gop: 120,
        bFrames: 2
      },
      audio: {
        codec: 'aac',
        channels: 1,
        layout: 'mono',
        sampleRate: 44_100,
        bitrateKbps: 128
      },
      delivery: {
        method: 'hls',
        container: 'mpegts',
        segmentType: 'mpegts',
        segmentDuration: 4,
        playlistType: 'live',
        latencyMode: 'standard'
      },
      processing: { toneMap: false, burnSubtitles: false, passthrough: 'never', maxWorkers: 1 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const args = liveNormalizerArgs(
      'rtsp://mediamtx:8554/live-ingest',
      'rtsp://mediamtx:8554/live-output',
      profile
    );

    expect(optionValue(args, '-i')).toBe('rtsp://mediamtx:8554/live-ingest');
    expect(optionValue(args, '-vf')).toContain(
      'scale=1280:720:force_original_aspect_ratio=decrease'
    );
    expect(optionValue(args, '-vf')).toContain('fps=60');
    expect(optionValue(args, '-vf')).toContain('format=yuv420p');
    expect(optionValue(args, '-c:v')).toBe('libx264');
    expect(optionValue(args, '-profile:v')).toBe('high');
    expect(optionValue(args, '-level:v')).toBe('4.1');
    expect(optionValue(args, '-preset')).toBe('veryfast');
    expect(optionValue(args, '-b:v')).toBe('5000k');
    expect(optionValue(args, '-maxrate')).toBe('5500k');
    expect(optionValue(args, '-bufsize')).toBe('11000k');
    expect(optionValue(args, '-g')).toBe('120');
    expect(optionValue(args, '-keyint_min')).toBe('120');
    expect(optionValue(args, '-bf')).toBe('2');
    expect(optionValue(args, '-c:a')).toBe('aac');
    expect(optionValue(args, '-b:a')).toBe('128k');
    expect(optionValue(args, '-ar')).toBe('44100');
    expect(optionValue(args, '-ac')).toBe('1');
    expect(args.at(-1)).toBe('rtsp://mediamtx:8554/live-output');
  });

  it('bounds concurrency, redacts diagnostics, and backs off after an unexpected exit', async () => {
    vi.useFakeTimers();
    const children: Array<
      ChildProcess & {
        stderr: PassThrough;
        finish(code: number): void;
      }
    > = [];
    const spawnChild = () => {
      const emitter = new EventEmitter() as ChildProcess & {
        stderr: PassThrough;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        finish(code: number): void;
      };
      emitter.stderr = new PassThrough();
      emitter.exitCode = null;
      emitter.signalCode = null;
      emitter.kill = vi.fn(() => true);
      emitter.finish = (code: number) => {
        emitter.exitCode = code;
        emitter.emit('exit', code, null);
      };
      children.push(emitter);
      queueMicrotask(() => emitter.emit('spawn'));
      return emitter;
    };
    const normalizer = new FFmpegLiveNormalizer({
      ffmpegPath: 'fixture-ffmpeg',
      maxConcurrent: 2,
      maxConcurrentPerOwner: 1,
      restartBackoffMinMs: 1_000,
      restartBackoffMaxMs: 8_000,
      maxStderrBytes: 128,
      spawnChild
    });
    const profile = {
      profileId: 'live-supervision',
      name: 'Live supervision',
      platform: 'universal',
      state: 'experimental',
      video: {
        codec: 'h264',
        decodeMode: 'auto',
        pixelFormat: 'yuv420p',
        width: 1280,
        height: 720,
        frameRate: 30,
        bitrateKbps: 4_000,
        maxrateKbps: 4_500,
        bufferKbps: 9_000,
        gop: 120,
        bFrames: 0
      },
      audio: {
        codec: 'aac',
        channels: 2,
        layout: 'stereo',
        sampleRate: 48_000,
        bitrateKbps: 192
      },
      delivery: {
        method: 'hls',
        container: 'mpegts',
        segmentType: 'mpegts',
        segmentDuration: 4,
        playlistType: 'live',
        latencyMode: 'standard'
      },
      processing: {
        toneMap: false,
        burnSubtitles: false,
        passthrough: 'never',
        maxWorkers: 1
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    } satisfies Profile;

    const starting = normalizer.start(
      'channel-a',
      'owner-a',
      'rtsp://mediamtx:8554/live-ingest?token=source-secret',
      'rtsp://mediamtx:8554/live-output',
      profile
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await starting;
    expect(normalizer.running('channel-a')).toBe(true);
    expect(normalizer.canStart('channel-b', 'owner-a')).toBe(false);
    expect(normalizer.canStart('channel-b', 'owner-b')).toBe(true);

    const secondStarting = normalizer.start(
      'channel-b',
      'owner-b',
      'rtsp://mediamtx:8554/second-ingest',
      'rtsp://mediamtx:8554/second-output',
      profile
    );
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await secondStarting;
    expect(normalizer.canStart('channel-c', 'owner-c')).toBe(false);

    children[0]!.stderr.write('failed rtsp://mediamtx:8554/live-ingest?token=publisher-secret');
    children[0]!.finish(1);
    expect(normalizer.running('channel-a')).toBe(false);
    expect(normalizer.canStart('channel-a', 'owner-a')).toBe(false);
    await expect(
      normalizer.start(
        'channel-a',
        'owner-a',
        'rtsp://mediamtx:8554/live-ingest',
        'rtsp://mediamtx:8554/live-output',
        profile
      )
    ).rejects.toThrow('restart backoff');
    expect(normalizer.recentError('channel-a')).not.toContain('publisher-secret');
    expect(normalizer.recentError('channel-a')).toContain('[REDACTED');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(normalizer.canStart('channel-a', 'owner-a')).toBe(true);
  });
});
