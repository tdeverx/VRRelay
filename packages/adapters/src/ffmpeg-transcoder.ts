// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Writable } from 'node:stream';
import type {
  EncoderCapability,
  MediaCapabilities,
  ResolvedSource,
  SegmentRequest,
  Transcoder,
  VodProducerRequest,
  ProducedVodSegment
} from '@vrrelay/application';
import type { Profile } from '@vrrelay/domain';
import { resolveFfmpegVideoEncoder, type VideoEncoderPreference } from './ffmpeg-encoder.js';
import { terminateChildProcess } from './supervised-child-process.js';

export interface FFmpegOptions {
  ffmpegPath: string;
  maxLogBytes?: number;
  videoEncoder?: VideoEncoderPreference;
}

/** @internal */
export function ffmpegDecodeAccelerationArgs(mode: Profile['video']['decodeMode']): string[] {
  // Do not ask FFmpeg to probe every compiled accelerator for `auto`. A build
  // can advertise CUDA or VA-API without the host libraries/devices needed to
  // initialise them, which makes otherwise portable work abort. Hardware
  // decode remains an explicit, validated profile choice.
  return mode === 'auto' || mode === 'software' ? [] : ['-hwaccel', mode];
}

/** @internal */
export function ffmpegVodReadPacingArgs(
  maximumCatchupRate: number,
  initialReadBurstSeconds: number,
  supportsCatchup = true
): string[] {
  if (!Number.isFinite(maximumCatchupRate) || maximumCatchupRate < 1 || maximumCatchupRate > 2)
    throw new Error('The VOD producer catch-up rate must be between 1x and 2x');
  if (!Number.isFinite(initialReadBurstSeconds) || initialReadBurstSeconds <= 0)
    throw new Error('The VOD producer initial read burst must be a finite positive duration');
  const args = [
    '-readrate',
    '1.000',
    '-readrate_initial_burst',
    initialReadBurstSeconds.toFixed(3)
  ];
  if (supportsCatchup) args.push('-readrate_catchup', maximumCatchupRate.toFixed(3));
  return args;
}

/** @internal */
export function ffmpegVideoEncoderCompatibilityArgs(encoder: string): string[] {
  // VideoToolbox can emit an internal H.264 SEI NAL that FFmpeg cannot safely
  // extend with A/53 caption data. VRRelay does not expose embedded captions,
  // so disable only that merge path while retaining hardware encoding.
  return encoder === 'h264_videotoolbox' ? ['-a53cc', '0'] : [];
}

/** @internal */
export async function monitorVodProducerOutput(
  runningProducer: Promise<void>,
  scan: () => Promise<void>,
  abortProducer: () => void,
  scanIntervalMs = 50
): Promise<void> {
  let outcome: { error?: unknown } | undefined;
  const completion = runningProducer.then(
    () => {
      outcome = {};
    },
    (error) => {
      outcome = { error };
    }
  );
  try {
    while (!outcome) {
      await scan();
      await new Promise((resolve) => setTimeout(resolve, scanIntervalMs));
    }
    await completion;
    await scan();
    if (outcome.error)
      throw outcome.error instanceof Error ? outcome.error : new Error('VOD producer failed');
  } catch (error) {
    abortProducer();
    await completion;
    throw error;
  }
}

export function redactFfmpegError(output: string): string {
  return output
    .replace(
      /\b(?:authorization|proxy-authorization|x-emby-token|cookie|set-cookie)\s*:[^\r\n]*/gi,
      '[REDACTED_HEADER]'
    )
    .replace(/(\/internal\/source\/)[^/?#\s'"<>]+/gi, '$1[REDACTED]')
    .replace(/(\/play\/)[^/?#\s'"<>]+/gi, '$1[REDACTED]')
    .replace(
      /([?&](?:access_token|api[_-]?key|auth|pass(?:phrase|word)?|signature|token|x-amz-signature)=)[^&\s'"<>]*/gi,
      '$1[REDACTED]'
    )
    .replace(/(\bstreamid=)[^&\s'"<>]*/gi, '$1[REDACTED]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, '[REDACTED_URL]');
}

export class FFmpegTranscoder implements Transcoder {
  readonly #ffmpegPath: string;
  readonly #maxLogBytes: number;
  readonly #videoEncoder: VideoEncoderPreference;
  #availableEncoders = new Set<string>();
  #supportsReadrateCatchup: boolean | undefined;

  constructor(options: FFmpegOptions) {
    this.#ffmpegPath = options.ffmpegPath;
    this.#maxLogBytes = options.maxLogBytes ?? 32_768;
    this.#videoEncoder = options.videoEncoder ?? 'auto';
  }

  async discover(signal?: AbortSignal): Promise<MediaCapabilities> {
    const [version, encoders, muxers, filters, pixelFormats, fullHelp] = await Promise.all([
      this.#capture(['-version'], signal),
      this.#capture(['-hide_banner', '-encoders'], signal),
      this.#capture(['-hide_banner', '-muxers'], signal),
      this.#capture(['-hide_banner', '-filters'], signal),
      this.#capture(['-hide_banner', '-pix_fmts'], signal),
      this.#capture(['-hide_banner', '-h', 'full'], signal)
    ]);
    this.#supportsReadrateCatchup = fullHelp.includes('-readrate_catchup');
    const availableEncoders = new Set(
      encoders
        .split('\n')
        .map((line) => line.match(/^\s*[A-Z.]{6}\s+(\S+)/)?.[1])
        .filter((value): value is string => Boolean(value))
    );
    this.#availableEncoders = availableEncoders;
    const candidates: Array<[string, string, boolean]> = [
      ['libx264', 'h264', false],
      ['h264_videotoolbox', 'h264', true],
      ['h264_nvenc', 'h264', true],
      ['h264_qsv', 'h264', true],
      ['h264_vaapi', 'h264', true],
      ['h264_amf', 'h264', true],
      ['libx265', 'h265', false],
      ['hevc_videotoolbox', 'h265', true],
      ['hevc_nvenc', 'h265', true],
      ['hevc_qsv', 'h265', true],
      ['hevc_vaapi', 'h265', true],
      ['hevc_amf', 'h265', true],
      ['libsvtav1', 'av1', false],
      ['av1_nvenc', 'av1', true],
      ['av1_qsv', 'av1', true],
      ['av1_amf', 'av1', true]
    ];
    const encoderCapabilities: EncoderCapability[] = await Promise.all(
      candidates.map(async ([name, codec, hardware]) => {
        if (!availableEncoders.has(name))
          return {
            name,
            codec,
            hardware,
            available: false,
            reason: 'Encoder is not present in the installed FFmpeg build'
          };
        const failure = await this.#probeEncoder(name, signal);
        return {
          name,
          codec,
          hardware,
          available: !failure,
          ...(failure ? { reason: failure } : {})
        };
      })
    );
    return {
      ffmpegVersion: version.split('\n')[0] ?? 'unknown',
      encoders: encoderCapabilities,
      muxers: this.#names(muxers),
      filters: this.#names(filters),
      pixelFormats: this.#names(pixelFormats)
    };
  }

  async generateSegment(
    request: SegmentRequest,
    destination: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (request.profile.delivery.segmentType === 'fmp4')
      return this.#generateFmp4Segment(request, destination, signal);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.part`;
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostdin',
      ...(request.source.positionedAtSeconds === request.startSeconds
        ? []
        : ['-ss', request.startSeconds.toFixed(3)]),
      ...this.#inputArgs(request.source, request.profile),
      '-t',
      request.duration.toFixed(3),
      '-map',
      '0:v:0',
      '-map',
      request.audioTrack === undefined ? '0:a:0?' : `0:${request.audioTrack}?`,
      ...this.#videoArgs(request.profile, request.source, request.subtitleTrack),
      ...this.#audioArgs(request.profile),
      '-avoid_negative_ts',
      'make_zero',
      '-muxdelay',
      '0',
      '-muxpreload',
      '0',
      '-f',
      'mpegts',
      '-y',
      temporary
    ];
    try {
      await this.#run(args, undefined, signal);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async produceVod(
    request: VodProducerRequest,
    directory: string,
    onSegment: (segment: ProducedVodSegment) => Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    await mkdir(directory, { recursive: true });
    const supportsReadrateCatchup =
      this.#supportsReadrateCatchup ??
      (await this.#capture(['-hide_banner', '-h', 'full'], signal)).includes('-readrate_catchup');
    this.#supportsReadrateCatchup = supportsReadrateCatchup;
    const fmp4 = request.profile.delivery.segmentType === 'fmp4';
    const extension = fmp4 ? 'm4s' : 'ts';
    const playlist = join(directory, 'producer.m3u8');
    const pattern = join(directory, `segment-%d.${extension}`);
    const initPath = fmp4 ? join(directory, 'init.mp4') : undefined;
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostdin',
      ...(request.source.positionedAtSeconds === request.startSeconds
        ? []
        : ['-ss', request.startSeconds.toFixed(3)]),
      // FFmpeg owns the media clock: build initial headroom without delay,
      // settle at playback speed, and use the configured ceiling only to
      // recover time lost while the input or output was blocked.
      ...ffmpegVodReadPacingArgs(
        request.readRate,
        request.initialReadBurstSeconds,
        supportsReadrateCatchup
      ),
      ...this.#inputArgs(request.source, request.profile),
      '-t',
      request.duration.toFixed(3),
      '-map',
      '0:v:0',
      '-map',
      request.audioTrack === undefined ? '0:a:0?' : `0:${request.audioTrack}?`,
      ...this.#videoArgs(request.profile, request.source, request.subtitleTrack),
      ...this.#audioArgs(request.profile),
      '-output_ts_offset',
      request.startSeconds.toFixed(3),
      '-f',
      'hls',
      '-hls_time',
      request.profile.delivery.segmentDuration.toFixed(3),
      '-hls_list_size',
      '0',
      '-hls_flags',
      'independent_segments+temp_file',
      '-start_number',
      String(request.startSegmentIndex),
      '-hls_segment_filename',
      pattern,
      ...(fmp4
        ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4']
        : ['-hls_segment_type', 'mpegts']),
      '-y',
      playlist
    ];
    const producerAbort = new AbortController();
    const producerSignal = signal
      ? AbortSignal.any([signal, producerAbort.signal])
      : producerAbort.signal;
    const published = new Set<number>();
    const scan = async () => {
      const files = await readdir(directory).catch(() => [] as string[]);
      const ready = files
        .map((file) => ({ file, match: file.match(new RegExp(`^segment-(\\d+)\\.${extension}$`)) }))
        .filter((entry): entry is { file: string; match: RegExpMatchArray } => Boolean(entry.match))
        .map((entry) => ({ file: entry.file, index: Number(entry.match[1]) }))
        .filter((entry) => !published.has(entry.index))
        .sort((left, right) => left.index - right.index);
      if (initPath)
        try {
          await access(initPath);
        } catch {
          return;
        }
      for (const segment of ready) {
        await onSegment({
          index: segment.index,
          path: join(directory, segment.file),
          ...(initPath ? { initPath } : {})
        });
        published.add(segment.index);
      }
    };
    await monitorVodProducerOutput(
      this.#run(args, undefined, producerSignal, false, directory),
      scan,
      () => producerAbort.abort()
    );
  }

  async #generateFmp4Segment(
    request: SegmentRequest,
    destination: string,
    signal?: AbortSignal
  ): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    const suffix = `${process.pid}-${Date.now()}`;
    const temporarySegment = `${destination}.${suffix}.part.m4s`;
    const temporaryInit = join(dirname(destination), `init.${suffix}.part.mp4`);
    const temporaryPlaylist = join(dirname(destination), `segment.${suffix}.m3u8`);
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostdin',
      '-ss',
      request.startSeconds.toFixed(3),
      ...this.#inputArgs(request.source, request.profile),
      '-t',
      request.duration.toFixed(3),
      '-map',
      '0:v:0',
      '-map',
      request.audioTrack === undefined ? '0:a:0?' : `0:${request.audioTrack}?`,
      ...this.#videoArgs(request.profile, request.source, request.subtitleTrack),
      ...this.#audioArgs(request.profile),
      '-f',
      'hls',
      '-hls_segment_type',
      'fmp4',
      '-hls_time',
      request.duration.toFixed(3),
      '-hls_list_size',
      '0',
      '-hls_flags',
      'independent_segments',
      '-hls_fmp4_init_filename',
      basename(temporaryInit),
      '-hls_segment_filename',
      temporarySegment,
      '-y',
      temporaryPlaylist
    ];
    try {
      await this.#run(args, undefined, signal);
      await rename(temporarySegment, destination);
      await rename(temporaryInit, join(dirname(destination), 'init.mp4'));
    } finally {
      await Promise.all([
        rm(temporarySegment, { force: true }),
        rm(temporaryInit, { force: true }),
        rm(temporaryPlaylist, { force: true })
      ]);
    }
  }

  #inputArgs(source: ResolvedSource, profile: Profile): string[] {
    const headerBlock = Object.entries(source.headers)
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join('');
    return [
      ...ffmpegDecodeAccelerationArgs(profile.video.decodeMode),
      ...(headerBlock ? ['-headers', headerBlock] : []),
      ...(source.positionedAtSeconds !== undefined ? ['-seekable', '0'] : []),
      '-i',
      source.url
    ];
  }

  #videoArgs(profile: Profile, source?: ResolvedSource, subtitleTrack?: number): string[] {
    const video = profile.video;
    const encoder = resolveFfmpegVideoEncoder(
      video.codec,
      this.#videoEncoder,
      this.#availableEncoders
    );
    if (encoder === 'copy') {
      if (profile.processing.toneMap || profile.processing.burnSubtitles)
        throw new Error(
          'Video passthrough cannot be combined with tone mapping or subtitle burn-in'
        );
      return ['-c:v', 'copy'];
    }
    const filters = [
      `scale=w=${video.width}:h=${video.height}:force_original_aspect_ratio=decrease`,
      `pad=${video.width}:${video.height}:(ow-iw)/2:(oh-ih)/2`,
      `fps=${video.frameRate}`
    ];
    if (profile.processing.toneMap)
      filters.push(
        'zscale=t=linear:npl=100',
        'tonemap=tonemap=hable:desat=0',
        'zscale=t=bt709:m=bt709:r=tv'
      );
    if (profile.processing.burnSubtitles && source && subtitleTrack !== undefined) {
      const escaped = source.url.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
      filters.push(`subtitles='${escaped}':si=${subtitleTrack}`);
    }
    if (encoder.includes('vaapi')) filters.push('format=nv12', 'hwupload');
    else if (encoder.includes('qsv')) filters.push('format=nv12', 'hwupload=extra_hw_frames=64');
    else filters.push(`format=${video.pixelFormat}`);
    return [
      '-vf',
      filters.join(','),
      '-c:v',
      encoder,
      ...ffmpegVideoEncoderCompatibilityArgs(encoder),
      '-b:v',
      `${video.bitrateKbps}k`,
      '-maxrate',
      `${video.maxrateKbps}k`,
      '-bufsize',
      `${video.bufferKbps}k`,
      '-g',
      String(video.gop),
      '-keyint_min',
      String(video.gop),
      '-sc_threshold',
      '0',
      '-bf',
      String(video.bFrames),
      ...(video.profile ? ['-profile:v', video.profile] : []),
      ...(video.level ? ['-level:v', video.level] : []),
      ...(video.preset && !encoder.includes('videotoolbox') ? ['-preset', video.preset] : [])
    ];
  }

  #audioArgs(profile: Profile): string[] {
    const audio = profile.audio;
    return audio.codec === 'copy'
      ? ['-c:a', 'copy']
      : [
          '-c:a',
          audio.codec,
          '-ac',
          String(audio.channels),
          '-ar',
          String(audio.sampleRate),
          '-channel_layout',
          audio.layout,
          '-b:a',
          `${audio.bitrateKbps}k`
        ];
  }

  async #capture(args: string[], signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const append = (chunk: Buffer) => {
        if (output.length < this.#maxLogBytes * 16) {
          output += chunk.toString().slice(0, this.#maxLogBytes * 16 - output.length);
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      let killTimer: NodeJS.Timeout | undefined;
      const abort = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, 3_000);
        killTimer.unref();
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
      child.once('error', (error) =>
        reject(new Error(`FFmpeg could not be started: ${redactFfmpegError(error.message)}`))
      );
      child.once('close', (code, killedBySignal) => {
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) return reject(new Error('FFmpeg was aborted'));
        if (code === 0) return resolve(output);
        reject(new Error(`FFmpeg discovery failed (${killedBySignal ?? code ?? 'unknown'})`));
      });
    });
  }

  async #probeEncoder(name: string, signal?: AbortSignal): Promise<string | undefined> {
    const timeout = AbortSignal.timeout(8_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      await this.#run(
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=size=64x64:rate=1:duration=0.1',
          '-frames:v',
          '1',
          '-vf',
          name.includes('vaapi') ? 'format=nv12,hwupload' : 'format=yuv420p',
          '-c:v',
          name,
          '-f',
          'null',
          '-'
        ],
        undefined,
        combined
      );
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Encoder self-test failed';
      return `Startup self-test failed: ${message.split('\n').at(-1)?.slice(0, 300) ?? 'unknown error'}`;
    }
  }

  #names(output: string): string[] {
    return [
      ...new Set(
        output
          .split('\n')
          .map((line) => line.match(/^\s*[A-Z.]{1,8}\s+(\S+)/)?.[1])
          .filter((value): value is string => Boolean(value))
      )
    ];
  }

  #run(
    args: string[],
    output?: Writable,
    signal?: AbortSignal,
    mergeStderr = false,
    cwd?: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(cwd ? { cwd } : {})
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (mergeStderr && output) output.write(chunk);
        if (stderr.length < this.#maxLogBytes)
          stderr += chunk.toString().slice(0, this.#maxLogBytes - stderr.length);
      });
      if (output) child.stdout.pipe(output, { end: !mergeStderr });
      let settled = false;
      let termination: Promise<void> | undefined;
      const cleanup = () => {
        signal?.removeEventListener('abort', abort);
        child.off('close', close);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const abort = () => {
        termination ??= terminateChildProcess(child).catch((error) => {
          fail(
            new Error(
              `FFmpeg could not be stopped: ${redactFfmpegError(
                error instanceof Error ? error.message : String(error)
              )}`
            )
          );
        });
      };
      const close = (code: number | null, killedBySignal: NodeJS.Signals | null) => {
        if (signal?.aborted) return fail(new Error('FFmpeg was aborted'));
        if (code === 0) return succeed();
        fail(
          new Error(
            `FFmpeg failed (${killedBySignal ?? code ?? 'unknown'}): ${redactFfmpegError(stderr.trim())}`
          )
        );
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.once('error', (error) =>
        fail(new Error(`FFmpeg could not be started: ${redactFfmpegError(error.message)}`))
      );
      child.once('close', close);
    });
  }
}
