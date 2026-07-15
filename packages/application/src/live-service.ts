// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type {
  LiveChannel,
  ProfileRevision,
  PublicLiveChannel,
  RelaySession
} from '@vrrelay/domain';
import { publicLiveChannel } from '@vrrelay/domain';
import type { CreateLiveChannelRequest } from '@vrrelay/contracts';
import type { ClusterRepository, EventBus, LiveNormalizer, Repository } from './index.js';
import { ConflictError, NotFoundError } from './errors.js';
import { createServiceEvent as event, hashToken, opaqueToken } from './service-helpers.js';

const MAX_LIVE_CHANNEL_WRITE_ATTEMPTS = 5;

export interface LiveServiceOptions {
  publicUrl: string;
  rtmpUrl: string;
  srtUrl: string;
  whipUrl: string;
  hlsUrl: string;
  internalRtspUrl: string;
  backupRtmpUrl?: string;
  backupSrtUrl?: string;
  allowUnauthenticatedInternalRead?: boolean;
}

export interface PublisherConnectionDetails {
  publishToken: string;
  rtmpUrl: string;
  srtUrl: string;
  whipUrl: string;
  backupRtmpUrl?: string;
  backupSrtUrl?: string;
}

function removePublisherCredential(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('user');
  parsed.searchParams.delete('pass');
  parsed.searchParams.delete('token');
  const streamId = parsed.searchParams.get('streamid');
  if (streamId?.startsWith('publish:')) {
    const [action, path] = streamId.split(':');
    parsed.searchParams.set('streamid', `${action}:${path}`);
  }
  return parsed.toString();
}

function sanitizeLiveChannel(channel: LiveChannel): LiveChannel {
  return {
    ...channel,
    rtmpUrl: removePublisherCredential(channel.rtmpUrl),
    srtUrl: removePublisherCredential(channel.srtUrl),
    whipUrl: removePublisherCredential(channel.whipUrl),
    ...(channel.backupRtmpUrl
      ? { backupRtmpUrl: removePublisherCredential(channel.backupRtmpUrl) }
      : {}),
    ...(channel.backupSrtUrl
      ? { backupSrtUrl: removePublisherCredential(channel.backupSrtUrl) }
      : {})
  };
}

function liveSessionOwnsChannel(session: RelaySession, channelId: string): boolean {
  return (
    session.kind === 'live' && session.liveChannelId === channelId && session.state !== 'stopped'
  );
}

export class LiveService {
  constructor(
    private readonly repository: Repository,
    private readonly options: LiveServiceOptions,
    private readonly normalizer?: LiveNormalizer,
    private readonly events?: EventBus,
    private readonly clusterRepository?: ClusterRepository
  ) {}

  async create(
    input: CreateLiveChannelRequest
  ): Promise<{ channel: PublicLiveChannel; publisher: PublisherConnectionDetails }> {
    const id = randomUUID();
    const path = `live-${opaqueToken(10)}`;
    const ingestPath = input.normalize ? `${path}-ingest` : path;
    const origin = await this.#selectOrigin(input.preferredRegion);
    const publishToken = opaqueToken(24);
    const publisher = this.#publisherConnectionDetails(ingestPath, publishToken);
    const channel: LiveChannel = {
      id,
      name: input.name,
      path,
      ...(input.normalize ? { ingestPath } : {}),
      ...(origin.originNodeId ? { originNodeId: origin.originNodeId } : {}),
      ...(origin.region ? { region: origin.region } : {}),
      normalize: input.normalize,
      publisherState: 'offline',
      publishTokenHash: hashToken(publishToken),
      rtmpUrl: `${this.options.rtmpUrl}/${ingestPath}`,
      srtUrl: `${this.options.srtUrl}?streamid=publish:${ingestPath}`,
      whipUrl: `${this.options.whipUrl}/${ingestPath}/whip`,
      ...(this.options.backupRtmpUrl
        ? {
            backupRtmpUrl: `${this.options.backupRtmpUrl}/${ingestPath}`
          }
        : {}),
      ...(this.options.backupSrtUrl
        ? {
            backupSrtUrl: `${this.options.backupSrtUrl}?streamid=publish:${ingestPath}`
          }
        : {}),
      createdAt: new Date().toISOString()
    };
    await this.repository.createLiveChannel(channel);
    return { channel: publicLiveChannel(channel), publisher };
  }

  async replacePublisher(
    channelId: string
  ): Promise<{ channel: PublicLiveChannel; publisher: PublisherConnectionDetails }> {
    let stored = await this.repository.getVersionedLiveChannel(channelId);
    if (!stored) throw new NotFoundError('Live channel was not found');
    const publishToken = opaqueToken(24);
    const replacementHash = hashToken(publishToken);
    const ingestPath = stored.value.ingestPath ?? stored.value.path;
    const publisher = this.#publisherConnectionDetails(ingestPath, publishToken);
    for (let attempt = 0; stored && attempt < MAX_LIVE_CHANNEL_WRITE_ATTEMPTS; attempt += 1) {
      const result = await this.repository.compareAndSetLiveChannel(
        {
          ...stored.value,
          replacementPublishTokenHash: replacementHash,
          publisherReplacementRequestedAt: new Date().toISOString()
        },
        stored.revision
      );
      if (result.applied)
        return {
          channel: publicLiveChannel(sanitizeLiveChannel(result.record.value)),
          publisher
        };
      if (result.reason === 'not-found') throw new NotFoundError('Live channel was not found');
      stored = result.current ?? (await this.repository.getVersionedLiveChannel(channelId));
    }
    throw new ConflictError('Live channel changed while replacement credentials were being issued');
  }

  async #claimPublisherSlot(channelId: string, suppliedTokenHash: string): Promise<boolean> {
    let stored = await this.repository.getVersionedLiveChannel(channelId);
    for (let attempt = 0; stored && attempt < MAX_LIVE_CHANNEL_WRITE_ATTEMPTS; attempt += 1) {
      const replacementMatches = suppliedTokenHash === stored.value.replacementPublishTokenHash;
      const primaryMatches = suppliedTokenHash === stored.value.publishTokenHash;
      if (!replacementMatches && !primaryMatches) return false;
      if (primaryMatches && stored.value.replacementPublishTokenHash) return false;
      if (
        !replacementMatches &&
        (stored.value.publisherState === 'online' || stored.value.publisherState === 'reconnecting')
      )
        return false;
      const next = replacementMatches
        ? this.#promoteReplacementPublisher(stored.value, suppliedTokenHash)
        : stored.value;
      const result = await this.repository.compareAndSetLiveChannel(
        {
          ...next,
          publisherState: 'reconnecting',
          publisherUpdatedAt: new Date().toISOString()
        },
        stored.revision
      );
      if (result.applied) return true;
      if (result.reason === 'not-found') return false;
      stored = result.current ?? (await this.repository.getVersionedLiveChannel(channelId));
    }
    return false;
  }

  #publisherConnectionDetails(
    ingestPath: string,
    publishToken: string
  ): PublisherConnectionDetails {
    const user = 'vrrelay-publish';
    return {
      publishToken,
      rtmpUrl: `${this.options.rtmpUrl}/${ingestPath}?user=${user}&pass=${publishToken}`,
      srtUrl: `${this.options.srtUrl}?streamid=publish:${ingestPath}:${user}:${publishToken}&pkt_size=1316`,
      whipUrl: `${this.options.whipUrl}/${ingestPath}/whip?token=${publishToken}`,
      ...(this.options.backupRtmpUrl
        ? {
            backupRtmpUrl: `${this.options.backupRtmpUrl}/${ingestPath}?user=${user}&pass=${publishToken}`
          }
        : {}),
      ...(this.options.backupSrtUrl
        ? {
            backupSrtUrl: `${this.options.backupSrtUrl}?streamid=publish:${ingestPath}:${user}:${publishToken}&pkt_size=1316`
          }
        : {})
    };
  }

  #promoteReplacementPublisher(channel: LiveChannel, replacementHash: string): LiveChannel {
    const {
      replacementPublishTokenHash: _replacementPublishTokenHash,
      publisherReplacementRequestedAt: _publisherReplacementRequestedAt,
      ...rest
    } = channel;
    return {
      ...rest,
      publishTokenHash: replacementHash
    };
  }

  async #selectOrigin(
    preferredRegion?: string
  ): Promise<{ originNodeId?: string; region?: string }> {
    const nodes = (await this.clusterRepository?.listNodes()) ?? [];
    const origins = nodes.filter(
      (node) => node.roles.includes('ingest-origin') && node.state === 'online'
    );
    const selected =
      (preferredRegion ? origins.find((node) => node.region === preferredRegion) : undefined) ??
      origins[0];
    return {
      ...(selected ? { originNodeId: selected.id, region: selected.region } : {}),
      ...(!selected && preferredRegion ? { region: preferredRegion } : {})
    };
  }

  async list(): Promise<PublicLiveChannel[]> {
    return (await this.repository.listLiveChannels()).map((channel) =>
      publicLiveChannel(sanitizeLiveChannel(channel))
    );
  }

  async delete(channelId: string): Promise<void> {
    const stored = await this.repository.getVersionedLiveChannel(channelId);
    if (!stored) throw new NotFoundError('Live channel was not found');
    const channel = stored.value;
    if (channel.publisherState !== 'offline')
      throw new ConflictError('Stop the OBS publisher before deleting this live channel');
    if (
      (await this.repository.listSessions()).some((session) => session.liveChannelId === channelId)
    )
      throw new ConflictError('Delete live playback sessions that use this channel first');
    if (this.normalizer?.running(channelId)) await this.normalizer.stop(channelId);
    const deleted = await this.repository.deleteLiveChannel(channelId, stored.revision);
    if (!deleted.applied) {
      if (deleted.reason === 'not-found') throw new NotFoundError('Live channel was not found');
      if (deleted.current?.value.publisherState !== 'offline')
        throw new ConflictError('Stop the OBS publisher before deleting this live channel');
      if (
        (await this.repository.listSessions()).some(
          (session) => session.liveChannelId === channelId
        )
      )
        throw new ConflictError('Delete live playback sessions that use this channel first');
      throw new ConflictError('Live channel changed while it was being deleted; try again');
    }
    this.events?.publish(event('live.channel.deleted', { channelId, name: channel.name }));
  }

  async scrubPersistedPublisherCredentials(): Promise<void> {
    for (const listed of await this.repository.listLiveChannels()) {
      let stored = await this.repository.getVersionedLiveChannel(listed.id);
      for (let attempt = 0; stored && attempt < 3; attempt += 1) {
        const sanitized = sanitizeLiveChannel(stored.value);
        if (JSON.stringify(sanitized) === JSON.stringify(stored.value)) break;
        const updated = await this.repository.compareAndSetLiveChannel(sanitized, stored.revision);
        if (updated.applied || updated.reason === 'not-found') break;
        stored = updated.current ?? (await this.repository.getVersionedLiveChannel(listed.id));
      }
    }
  }

  async reconcilePublisherPaths(readyPaths: ReadonlySet<string>): Promise<void> {
    for (const listed of await this.repository.listLiveChannels()) {
      const stored = await this.repository.getVersionedLiveChannel(listed.id);
      if (!stored) continue;
      let channel = stored.value;
      const ingestPath = channel.ingestPath ?? channel.path;
      const online = readyPaths.has(ingestPath);
      const state = online ? 'online' : 'offline';
      if (channel.publisherState !== state) {
        const updated: LiveChannel = {
          ...channel,
          publisherState: state,
          publisherUpdatedAt: new Date().toISOString()
        };
        const result = await this.repository.compareAndSetLiveChannel(updated, stored.revision);
        if (!result.applied) continue;
        channel = result.record.value;
        this.events?.publish(
          event(online ? 'live.publisher.connected' : 'live.publisher.disconnected', {
            channelId: channel.id,
            path: channel.path
          })
        );
      }
      if (!channel.normalize || !this.normalizer) continue;
      const profile = await this.#normalizationProfile(channel);
      if (!profile) {
        if (this.normalizer.running(channel.id)) await this.normalizer.stop(channel.id);
        continue;
      }
      if (online && !this.normalizer.running(channel.id)) {
        await this.normalizer.start(
          channel.id,
          `${this.options.internalRtspUrl}/${ingestPath}`,
          `${this.options.internalRtspUrl}/${channel.path}`,
          profile
        );
      } else if (!online && this.normalizer.running(channel.id)) {
        await this.normalizer.stop(channel.id);
      }
    }
  }

  async #normalizationProfile(channel: LiveChannel): Promise<ProfileRevision | undefined> {
    if (channel.normalizationProfileId && channel.normalizationProfileRevision) {
      return this.repository.getProfile(
        channel.normalizationProfileId,
        channel.normalizationProfileRevision
      );
    }
    const session = (await this.repository.listSessions()).find((candidate) =>
      liveSessionOwnsChannel(candidate, channel.id)
    );
    if (!session) return undefined;
    return this.repository.getProfile(session.profileId, session.profileRevision);
  }

  async stop(): Promise<void> {
    if (!this.normalizer) return;
    for (const channel of await this.repository.listLiveChannels())
      await this.normalizer.stop(channel.id);
  }

  async authorizeMediaMtx(
    input: {
      action: string;
      path: string;
      protocol?: string | undefined;
      user?: string | undefined;
      password?: string | undefined;
      token?: string | undefined;
    },
    readToken: string
  ): Promise<boolean> {
    if (input.action === 'read' || input.action === 'playback') {
      if (
        this.options.allowUnauthenticatedInternalRead &&
        input.protocol === 'rtsp' &&
        !input.user &&
        !input.password &&
        !input.token
      )
        return true;
      return (
        input.user === 'vrrelay-read' && (input.password === readToken || input.token === readToken)
      );
    }
    if (input.action !== 'publish') return false;
    const channels = await this.repository.listLiveChannels();
    // FFmpeg reads and republishes over the private RTSP listener. The bundled
    // deployments never expose this listener publicly; allowing only RTSP and
    // only a generated normalized-output path avoids placing a reusable secret
    // in FFmpeg's process arguments.
    if (
      this.options.allowUnauthenticatedInternalRead &&
      input.protocol === 'rtsp' &&
      !input.user &&
      !input.password &&
      !input.token
    ) {
      return channels.some((channel) => channel.normalize && channel.path === input.path);
    }
    if (input.user !== 'vrrelay-publish') return false;
    const channel = channels.find(
      (candidate) => (candidate.ingestPath ?? candidate.path) === input.path
    );
    const supplied = input.password ?? input.token ?? '';
    const suppliedTokenHash = supplied ? hashToken(supplied) : '';
    if (
      !channel ||
      !suppliedTokenHash ||
      (suppliedTokenHash !== channel.publishTokenHash &&
        suppliedTokenHash !== channel.replacementPublishTokenHash)
    )
      return false;
    return this.#claimPublisherSlot(channel.id, suppliedTokenHash);
  }
}
