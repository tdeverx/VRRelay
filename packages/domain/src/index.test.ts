// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { VideoSettingsSchema } from './index.js';

const video = {
  codec: 'h264',
  decodeMode: 'auto',
  profile: 'high',
  level: '4.1',
  pixelFormat: 'yuv420p',
  width: 1920,
  height: 1080,
  frameRate: 30,
  bitrateKbps: 8_000,
  maxrateKbps: 8_500,
  bufferKbps: 17_000,
  preset: 'veryfast',
  tune: 'film',
  gop: 120,
  bFrames: 0
} as const;

describe('structured FFmpeg option validation', () => {
  it('accepts bounded capability names without admitting filtergraph syntax', () => {
    expect(VideoSettingsSchema.safeParse(video).success).toBe(true);
    for (const pixelFormat of ['yuv420p,negate', 'movie=file', 'yuv420p;scale=1:1'])
      expect(VideoSettingsSchema.safeParse({ ...video, pixelFormat }).success).toBe(false);
  });
});
