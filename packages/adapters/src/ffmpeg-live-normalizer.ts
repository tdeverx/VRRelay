// SPDX-License-Identifier: GPL-3.0-or-later
import type { LiveNormalizer } from '@vrrelay/application';
import type { Profile } from '@vrrelay/domain';
import { redactFfmpegError } from './ffmpeg-transcoder.js';
import { resolveFfmpegVideoEncoder, type VideoEncoderPreference } from './ffmpeg-encoder.js';
import { SupervisedChildProcess, type SpawnChildProcess } from './supervised-child-process.js';

export interface FFmpegLiveNormalizerOptions {
  ffmpegPath: string;
  maxConcurrent?: number;
  maxConcurrentPerOwner?: number;
  restartBackoffMinMs?: number;
  restartBackoffMaxMs?: number;
  maxStderrBytes?: number;
  spawnChild?: SpawnChildProcess;
  videoEncoder?: VideoEncoderPreference;
  availableEncoders?: ReadonlySet<string>;
}

function optionalArgs(condition: unknown, args: string[]): string[] {
  return condition ? args : [];
}

export function liveNormalizerArgs(
  sourceUrl: string,
  destinationUrl: string,
  profile: Profile,
  videoEncoder: VideoEncoderPreference = 'auto',
  availableEncoders: ReadonlySet<string> = new Set()
): string[] {
  const encoder = resolveFfmpegVideoEncoder(profile.video.codec, videoEncoder, availableEncoders);
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
    encoder,
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
  readonly #processes = new Map<string, SupervisedChildProcess>();
  readonly #owners = new Map<string, string>();
  readonly #restartFailures = new Map<string, number>();
  readonly #restartNotBefore = new Map<string, number>();
  readonly #recentErrors = new Map<string, string>();

  constructor(private readonly options: FFmpegLiveNormalizerOptions) {}

  running(channelId: string): boolean {
    return this.#processes.has(channelId);
  }

  canStart(channelId: string, ownerId?: string): boolean {
    if (this.#processes.has(channelId)) return true;
    if (this.#processes.size >= (this.options.maxConcurrent ?? 2)) return false;
    const owner = ownerId ?? '__unowned__';
    const ownerProcesses = [...this.#owners.values()].filter(
      (candidate) => candidate === owner
    ).length;
    if (ownerProcesses >= (this.options.maxConcurrentPerOwner ?? Number.MAX_SAFE_INTEGER))
      return false;
    return (this.#restartNotBefore.get(channelId) ?? 0) <= Date.now();
  }

  recentError(channelId: string): string | undefined {
    return this.#recentErrors.get(channelId);
  }

  async start(
    channelId: string,
    ownerId: string | undefined,
    sourceUrl: string,
    destinationUrl: string,
    profile: Profile,
    signal?: AbortSignal
  ): Promise<void> {
    if (this.#processes.has(channelId)) await this.stop(channelId);
    if (!this.canStart(channelId, ownerId))
      throw new Error('Live normalizer capacity or restart backoff is active');
    const supervisor = new SupervisedChildProcess({
      executable: this.options.ffmpegPath,
      arguments: liveNormalizerArgs(
        sourceUrl,
        destinationUrl,
        profile,
        this.options.videoEncoder,
        this.options.availableEncoders
      ),
      spawnOptions: { stdio: ['ignore', 'ignore', 'pipe'] },
      startupGraceMs: 250,
      gracefulStopMs: 3_000,
      maxStderrBytes: this.options.maxStderrBytes ?? 32_768,
      redact: redactFfmpegError,
      ...(this.options.spawnChild ? { spawnChild: this.options.spawnChild } : {}),
      onUnexpectedExit: (error) => {
        if (this.#processes.get(channelId) !== supervisor) return;
        this.#processes.delete(channelId);
        this.#owners.delete(channelId);
        this.#recentErrors.set(channelId, error.message);
        this.#recordFailure(channelId, startedAt);
      }
    });
    const startedAt = Date.now();
    this.#processes.set(channelId, supervisor);
    this.#owners.set(channelId, ownerId ?? '__unowned__');
    try {
      await supervisor.start(signal);
      this.#recentErrors.delete(channelId);
    } catch (error) {
      if (this.#processes.get(channelId) === supervisor) {
        this.#processes.delete(channelId);
        this.#owners.delete(channelId);
        this.#recentErrors.set(
          channelId,
          redactFfmpegError(error instanceof Error ? error.message : String(error))
        );
        this.#recordFailure(channelId, startedAt);
      }
      throw error;
    }
  }

  async stop(channelId: string): Promise<void> {
    const supervisor = this.#processes.get(channelId);
    this.#processes.delete(channelId);
    this.#owners.delete(channelId);
    this.#restartFailures.delete(channelId);
    this.#restartNotBefore.delete(channelId);
    if (!supervisor) return;
    await supervisor.stop();
  }

  #recordFailure(channelId: string, startedAt: number): void {
    const stable = Date.now() - startedAt >= 30_000;
    const failures = stable ? 1 : (this.#restartFailures.get(channelId) ?? 0) + 1;
    this.#restartFailures.set(channelId, failures);
    const minimum = this.options.restartBackoffMinMs ?? 1_000;
    const maximum = this.options.restartBackoffMaxMs ?? 60_000;
    this.#restartNotBefore.set(
      channelId,
      Date.now() + Math.min(maximum, minimum * 2 ** Math.min(failures - 1, 10))
    );
  }
}
