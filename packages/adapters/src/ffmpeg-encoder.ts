// SPDX-License-Identifier: GPL-3.0-or-later
import type { VideoSettings } from '@vrrelay/domain';

export type VideoEncoderPreference =
  'auto' | 'software' | 'videotoolbox' | 'nvenc' | 'qsv' | 'vaapi' | 'amf';

const encoders: Record<
  Exclude<VideoSettings['codec'], 'copy'>,
  Partial<Record<Exclude<VideoEncoderPreference, 'auto'>, string>>
> = {
  h264: {
    software: 'libx264',
    videotoolbox: 'h264_videotoolbox',
    nvenc: 'h264_nvenc',
    qsv: 'h264_qsv',
    vaapi: 'h264_vaapi',
    amf: 'h264_amf'
  },
  h265: {
    software: 'libx265',
    videotoolbox: 'hevc_videotoolbox',
    nvenc: 'hevc_nvenc',
    qsv: 'hevc_qsv',
    vaapi: 'hevc_vaapi',
    amf: 'hevc_amf'
  },
  av1: {
    software: 'libsvtav1',
    nvenc: 'av1_nvenc',
    qsv: 'av1_qsv',
    amf: 'av1_amf'
  }
};

const automaticOrder: Exclude<VideoEncoderPreference, 'auto'>[] = [
  'videotoolbox',
  'nvenc',
  'qsv',
  'vaapi',
  'amf',
  'software'
];

export function resolveFfmpegVideoEncoder(
  codec: VideoSettings['codec'],
  preference: VideoEncoderPreference,
  available: ReadonlySet<string>
): string {
  if (codec === 'copy') return 'copy';
  const choices = encoders[codec];
  if (preference === 'auto') {
    if (available.size === 0) return choices.software!;
    for (const backend of automaticOrder) {
      const encoder = choices[backend];
      if (encoder && available.has(encoder)) return encoder;
    }
    throw new Error(`No available FFmpeg encoder supports ${codec}`);
  }
  const encoder = choices[preference];
  if (!encoder) throw new Error(`${preference} does not support ${codec}`);
  if (available.size > 0 && !available.has(encoder))
    throw new Error(`The configured ${preference} encoder for ${codec} is unavailable`);
  return encoder;
}
