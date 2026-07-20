// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { ProfileRevision } from '@vrrelay/domain';
import type { CreateProfileRevisionRequest } from '@vrrelay/contracts';
import type { MediaCapabilities, Repository } from './index.js';
import { ConflictError } from './errors.js';

function assertImplementedProfile(input: CreateProfileRevisionRequest): void {
  if (input.state === 'verified')
    throw new ConflictError(
      'Profile revisions must start as experimental until compatibility evidence promotes them'
    );
  if (input.delivery.latencyMode !== 'standard')
    throw new ConflictError('Low-latency delivery profiles are not implemented');
  if (input.processing.passthrough !== 'never')
    throw new ConflictError('Passthrough policy profiles are not implemented');

  if (input.delivery.method === 'rtsp' || input.delivery.method === 'mpegts_http')
    throw new ConflictError('RTSP and HTTP MPEG-TS delivery profiles are not implemented');

  if (input.delivery.method === 'hls') {
    if (input.delivery.playlistType === 'event')
      throw new ConflictError('HLS event playlists are not implemented');
    if (input.delivery.container === 'mpegts' && input.delivery.segmentType === 'mpegts') return;
    if (input.delivery.container === 'fmp4' && input.delivery.segmentType === 'fmp4') return;
    throw new ConflictError('HLS profiles must use matching MPEG-TS or fMP4 segment settings');
  }

  if (
    input.delivery.container !== 'mp4' ||
    input.delivery.segmentType !== 'none' ||
    input.delivery.playlistType !== 'vod'
  )
    throw new ConflictError(
      'Fragmented MP4 profiles must use MP4 container, no segment output, and VOD playlist type'
    );
}

export class ProfileService {
  constructor(private readonly repository: Repository) {}

  async seed(capabilities: MediaCapabilities): Promise<void> {
    if ((await this.repository.listProfiles()).length > 0) return;
    const available = new Set(
      capabilities.encoders.filter((encoder) => encoder.available).map((encoder) => encoder.name)
    );
    const h264Encoder =
      ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi', 'libx264'].find(
        (encoder) => available.has(encoder)
      ) ?? 'libx264';
    const hardwareMode = h264Encoder.includes('videotoolbox')
      ? 'videotoolbox'
      : h264Encoder.includes('nvenc')
        ? 'nvenc'
        : h264Encoder.includes('qsv')
          ? 'qsv'
          : h264Encoder.includes('amf')
            ? 'amf'
            : h264Encoder.includes('vaapi')
              ? 'vaapi'
              : 'software';
    const now = new Date().toISOString();
    const base: Omit<
      ProfileRevision,
      'profileId' | 'revision' | 'name' | 'description' | 'platform' | 'state' | 'createdAt'
    > = {
      video: {
        codec: 'h264',
        encoder: h264Encoder,
        hardwareMode,
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
        gop: 120,
        bFrames: 0
      },
      audio: {
        codec: 'aac',
        channels: 2,
        layout: 'stereo',
        sampleRate: 48_000,
        bitrateKbps: 192,
        defaultLanguage: 'eng'
      },
      delivery: {
        method: 'hls',
        container: 'mpegts',
        segmentType: 'mpegts',
        segmentDuration: 4,
        playlistType: 'vod',
        latencyMode: 'standard'
      },
      processing: { toneMap: false, burnSubtitles: false, passthrough: 'never', maxWorkers: 2 }
    };
    const profiles: ProfileRevision[] = [
      {
        ...base,
        profileId: 'universal-h264-hls-vod',
        revision: 1,
        name: 'Universal H.264 / AAC HLS',
        description: 'Finite MPEG-TS HLS VOD baseline for PC and Quest testing.',
        platform: 'universal',
        state: 'experimental',
        createdAt: now
      },
      {
        ...base,
        profileId: 'pc-h264-hls-vod',
        revision: 1,
        name: 'PC H.264 1080p',
        description: 'Higher-bitrate PC-oriented HLS VOD output.',
        platform: 'pc',
        state: 'experimental',
        video: { ...base.video, bitrateKbps: 12_000, maxrateKbps: 13_000, bufferKbps: 26_000 },
        createdAt: now
      },
      {
        ...base,
        profileId: 'quest-h264-hls-vod',
        revision: 1,
        name: 'Quest H.264 720p',
        description: 'Conservative Quest-oriented H.264/AAC profile.',
        platform: 'quest',
        state: 'experimental',
        video: {
          ...base.video,
          width: 1280,
          height: 720,
          bitrateKbps: 4_000,
          maxrateKbps: 4_500,
          bufferKbps: 9_000
        },
        createdAt: now
      },
      {
        ...base,
        profileId: 'h264-live-hls',
        revision: 1,
        name: 'H.264 / AAC Live HLS',
        description: 'Standard-latency HLS output for OBS live channels.',
        platform: 'universal',
        state: 'experimental',
        delivery: { ...base.delivery, playlistType: 'live' },
        createdAt: now
      },
      {
        ...base,
        profileId: 'universal-h264-fmp4-hls-vod',
        revision: 1,
        name: 'Universal H.264 / AAC fMP4 HLS',
        description: 'Experimental finite fMP4 HLS VOD output.',
        platform: 'universal',
        state: 'experimental',
        delivery: { ...base.delivery, container: 'fmp4', segmentType: 'fmp4' },
        createdAt: now
      },
      {
        ...base,
        profileId: 'fragmented-mp4',
        revision: 1,
        name: 'Fragmented MP4',
        description: 'Experimental direct fragmented MP4 for Unity-player compatibility testing.',
        platform: 'pc',
        state: 'experimental',
        delivery: {
          method: 'fragmented_mp4',
          container: 'mp4',
          segmentType: 'none',
          segmentDuration: 4,
          playlistType: 'vod',
          latencyMode: 'standard'
        },
        createdAt: now
      }
    ];
    for (const profile of profiles) await this.repository.putProfile(profile);
  }

  async list(): Promise<ProfileRevision[]> {
    return this.repository.listProfiles();
  }

  async createRevision(input: CreateProfileRevisionRequest): Promise<ProfileRevision> {
    assertImplementedProfile(input);
    const profileId = input.profileId ?? randomUUID();
    const previous = await this.repository.getProfile(profileId);
    const profile: ProfileRevision = {
      ...input,
      profileId,
      revision: (previous?.revision ?? 0) + 1,
      createdAt: new Date().toISOString()
    };
    await this.repository.putProfile(profile);
    return profile;
  }
}
