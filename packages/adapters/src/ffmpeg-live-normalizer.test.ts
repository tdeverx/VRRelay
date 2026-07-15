import { describe, expect, it } from 'vitest';
import type { ProfileRevision } from '@vrrelay/domain';
import { liveNormalizerArgs } from './ffmpeg-live-normalizer.js';

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

describe('FFmpeg live normalizer', () => {
  it('builds the live normalization command from the selected profile', () => {
    const profile: ProfileRevision = {
      profileId: 'live-720p60',
      revision: 3,
      name: 'Live 720p60',
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
      createdAt: new Date().toISOString()
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
});
