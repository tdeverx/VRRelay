// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcess } from 'node:child_process';
import type { LiveNormalizer } from '@vrrelay/application';
import type { ProfileRevision } from '@vrrelay/domain';

export interface FFmpegLiveNormalizerOptions {
  ffmpegPath: string;
}

function optionalArgs(condition: unknown, args: string[]): string[] {
  return condition ? args : [];
}

export function liveNormalizerArgs(
  sourceUrl: string,
  destinationUrl: string,
  profile: ProfileRevision
): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-rtsp_transport',
    'tcp',
    '-i',
    sourceUrl,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    [
      `scale=${profile.video.width}:${profile.video.height}:force_original_aspect_ratio=decrease`,
      `pad=${profile.video.width}:${profile.video.height}:(ow-iw)/2:(oh-ih)/2`,
      `fps=${profile.video.frameRate}`,
      `format=${profile.video.pixelFormat}`
    ].join(','),
    '-c:v',
    profile.video.encoder,
    ...optionalArgs(profile.video.profile, ['-profile:v', profile.video.profile!]),
    ...optionalArgs(profile.video.level, ['-level:v', profile.video.level!]),
    ...optionalArgs(profile.video.preset, ['-preset', profile.video.preset!]),
    '-b:v',
    `${profile.video.bitrateKbps}k`,
    '-maxrate',
    `${profile.video.maxrateKbps}k`,
    '-bufsize',
    `${profile.video.bufferKbps}k`,
    '-g',
    String(profile.video.gop),
    '-keyint_min',
    String(profile.video.gop),
    '-bf',
    String(profile.video.bFrames),
    '-sc_threshold',
    '0',
    '-c:a',
    profile.audio.codec,
    '-b:a',
    `${profile.audio.bitrateKbps}k`,
    '-ar',
    String(profile.audio.sampleRate),
    '-ac',
    String(profile.audio.channels),
    '-f',
    'rtsp',
    '-rtsp_transport',
    'tcp',
    destinationUrl
  ];
}

export class FFmpegLiveNormalizer implements LiveNormalizer {
  readonly #processes = new Map<string, ChildProcess>();

  constructor(private readonly options: FFmpegLiveNormalizerOptions) {}

  running(channelId: string): boolean {
    return this.#processes.has(channelId);
  }

  async start(
    channelId: string,
    sourceUrl: string,
    destinationUrl: string,
    profile: ProfileRevision,
    signal?: AbortSignal
  ): Promise<void> {
    await this.stop(channelId);
    const args = liveNormalizerArgs(sourceUrl, destinationUrl, profile);
    const child = spawn(this.options.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.#processes.set(channelId, child);
    child.once('exit', () => this.#processes.delete(channelId));
    signal?.addEventListener('abort', () => void this.stop(channelId), { once: true });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve();
      }, 250);
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        if (!settled && code !== 0) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Live normalizer exited during startup (${code})`));
        }
      });
    });
  }

  async stop(channelId: string): Promise<void> {
    const child = this.#processes.get(channelId);
    if (!child) return;
    this.#processes.delete(channelId);
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    clearTimeout(timer);
  }
}
