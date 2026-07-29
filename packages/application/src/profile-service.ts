// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { Profile } from '@vrrelay/domain';
import type { ProfileInput } from '@vrrelay/contracts';
import type { MediaCapabilities, Repository } from './index.js';
import { ConflictError, NotFoundError } from './errors.js';

function assertImplementedProfile(input: ProfileInput, allowVerified = false): void {
  if (input.state === 'verified' && !allowVerified)
    throw new ConflictError(
      'Profiles must start as experimental until compatibility evidence promotes them'
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
    if ((await this.repository.listProfiles()).length > 0) return;
    if (!capabilities.encoders.some((encoder) => encoder.codec === 'h264' && encoder.available))
      throw new ConflictError('The built-in profiles require an available H.264 encoder');

    const now = new Date().toISOString();
    const base: Omit<
      Profile,
      'profileId' | 'name' | 'description' | 'platform' | 'state' | 'createdAt' | 'updatedAt'
    > = {
      video: {
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
    const profiles: Profile[] = [
      {
        ...base,
        profileId: 'universal-h264-hls-vod',
        name: 'Universal H.264 / AAC HLS',
        description: 'Finite MPEG-TS HLS VOD baseline for PC and Quest testing.',
        platform: 'universal',
        state: 'experimental',
        createdAt: now,
        updatedAt: now
      },
      {
        ...base,
        profileId: 'pc-h264-hls-vod',
        name: 'PC H.264 1080p',
        description: 'Higher-bitrate PC-oriented HLS VOD output.',
        platform: 'pc',
        state: 'experimental',
        video: { ...base.video, bitrateKbps: 12_000, maxrateKbps: 13_000, bufferKbps: 26_000 },
        createdAt: now,
        updatedAt: now
      },
      {
        ...base,
        profileId: 'quest-h264-hls-vod',
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
        createdAt: now,
        updatedAt: now
      },
      {
        ...base,
        profileId: 'h264-live-hls',
        name: 'H.264 / AAC Live HLS',
        description: 'Standard-latency HLS output for OBS live channels.',
        platform: 'universal',
        state: 'experimental',
        delivery: { ...base.delivery, playlistType: 'live' },
        createdAt: now,
        updatedAt: now
      },
      {
        ...base,
        profileId: 'universal-h264-fmp4-hls-vod',
        name: 'Universal H.264 / AAC fMP4 HLS',
        description: 'Experimental finite fMP4 HLS VOD output.',
        platform: 'universal',
        state: 'experimental',
        delivery: { ...base.delivery, container: 'fmp4', segmentType: 'fmp4' },
        createdAt: now,
        updatedAt: now
      }
    ];
    for (const profile of profiles) await this.repository.putProfile(profile);
  }

  async list(): Promise<Profile[]> {
    return this.repository.listProfiles();
  }

  async create(input: ProfileInput): Promise<Profile> {
    await this.#validate(input);
    const profileId = randomUUID();
    const now = new Date().toISOString();
    const profile: Profile = { ...input, profileId, createdAt: now, updatedAt: now };
    await this.repository.putProfile(profile);
    return profile;
  }

  async update(profileId: string, input: ProfileInput): Promise<Profile> {
    const current = await this.repository.getProfile(profileId);
    if (!current) throw new NotFoundError('Profile was not found');
    await this.#validate(input, current.state === 'verified');
    const profile: Profile = {
      ...input,
      profileId,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    };
    await this.repository.putProfile(profile);
    return profile;
  }

  async delete(profileId: string): Promise<void> {
    if (!(await this.repository.getProfile(profileId)))
      throw new NotFoundError('Profile was not found');
    const inUse =
      (await this.repository.listSessions()).some((session) => session.profileId === profileId) ||
      (await this.repository.listLiveChannels()).some(
        (channel) => channel.normalizationProfileId === profileId
      ) ||
      (await this.repository.listCompatibilityResults()).some(
        (result) => result.profileId === profileId
      ) ||
      (await this.repository.listUserIdentities()).some(
        ({ value }) =>
          value.defaultProfileId === profileId || value.allowedProfileIds.includes(profileId)
      );
    if (inUse)
      throw new ConflictError(
        'Profile is still assigned to a session, live channel, compatibility result, or user entitlement'
      );
    await this.repository.deleteProfile(profileId);
  }

  async #validate(input: ProfileInput, allowVerified = false): Promise<void> {
    assertImplementedProfile(input, allowVerified);
    const capabilities = this.#capabilities;
    if (!capabilities)
      throw new ConflictError('Media capabilities must be discovered before profiles can be saved');
    if (
      input.video.codec !== 'copy' &&
      !capabilities.encoders.some(
        (encoder) => encoder.available && encoder.codec === input.video.codec
      )
    )
      throw new ConflictError('No available encoder supports the selected video codec');
    if (!capabilities.pixelFormats.includes(input.video.pixelFormat))
      throw new ConflictError('The selected pixel format is not available on this relay');
  }
}
