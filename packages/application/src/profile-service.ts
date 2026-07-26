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

  if ((input.delivery.method as string) === 'fragmented_mp4')
    throw new ConflictError('Direct fragmented MP4 delivery is not supported');
  if (input.delivery.method === 'rtsp' || input.delivery.method === 'mpegts_http')
    throw new ConflictError('RTSP and HTTP MPEG-TS delivery profiles are not implemented');
  if (input.delivery.method === 'hls') {
    if (input.delivery.playlistType === 'event')
      throw new ConflictError('HLS event playlists are not implemented');
    if (input.delivery.container === 'mpegts' && input.delivery.segmentType === 'mpegts') return;
    if (input.delivery.container === 'fmp4' && input.delivery.segmentType === 'fmp4') return;
    throw new ConflictError('HLS profiles must use matching MPEG-TS or fMP4 segment settings');
  }
}

export class ProfileService {
  #capabilities: MediaCapabilities | undefined;

  constructor(
    private readonly repository: Repository,
    capabilities?: MediaCapabilities
  ) {
    this.#capabilities = capabilities;
  }

  async seed(capabilities = this.#capabilities): Promise<void> {
    if (!capabilities)
      throw new ConflictError(
        'Media capabilities must be discovered before profiles can be seeded'
      );
    this.#capabilities = capabilities;
    const existingProfiles = await this.repository.listProfiles();
    const available = new Set(
      capabilities.encoders.filter((encoder) => encoder.available).map((encoder) => encoder.name)
    );
    if (!available.has('libx264'))
      throw new ConflictError('The portable built-in profiles require the libx264 encoder');
    const now = new Date().toISOString();
    const base: Omit<
      ProfileRevision,
      'profileId' | 'revision' | 'name' | 'description' | 'platform' | 'state' | 'createdAt'
    > = {
      video: {
        codec: 'h264',
        encoder: 'libx264',
        hardwareMode: 'software',
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
      }
    ];
    for (const profile of profiles) {
      const latest = existingProfiles
        .filter((existing) => existing.profileId === profile.profileId)
        .sort((left, right) => right.revision - left.revision)[0];
      if (!latest) {
        await this.repository.putProfile(profile);
        continue;
      }
      if (
        latest.revision === 1 &&
        latest.name === profile.name &&
        (latest.video.encoder !== 'libx264' || latest.video.hardwareMode !== 'software')
      )
        await this.repository.putProfile({
          ...latest,
          revision: 2,
          video: { ...latest.video, encoder: 'libx264', hardwareMode: 'software' },
          createdAt: now
        });
    }
  }

  async list(): Promise<ProfileRevision[]> {
    return this.repository.listProfiles();
  }

  async createRevision(input: CreateProfileRevisionRequest): Promise<ProfileRevision> {
    assertImplementedProfile(input);
    const capabilities = this.#capabilities;
    if (!capabilities)
      throw new ConflictError(
        'Media capabilities must be discovered before profiles can be created'
      );
    if (
      !capabilities.encoders.some(
        (encoder) => encoder.available && encoder.name === input.video.encoder
      )
    )
      throw new ConflictError('The selected video encoder is not available on this relay');
    if (!capabilities.pixelFormats.includes(input.video.pixelFormat))
      throw new ConflictError('The selected pixel format is not available on this relay');
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
