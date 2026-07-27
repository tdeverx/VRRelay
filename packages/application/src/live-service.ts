// SPDX-License-Identifier: GPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import type { LiveChannel, Profile, PublicLiveChannel, RelaySession } from '@vrrelay/domain';
import { publicLiveChannel } from '@vrrelay/domain';
import type { CreateLiveChannelRequest } from '@vrrelay/contracts';
import type {
  ClusterRepository,
  EventBus,
  LiveNormalizer,
  MetricsSink,
  Repository
} from './index.js';
import { CapacityError, ConflictError, NotFoundError } from './errors.js';
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
  maxChannelsTotal?: number;
  maxChannelsPerOwner?: number;
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
    private readonly clusterRepository?: ClusterRepository,
    private readonly metrics?: MetricsSink
  ) {}

  async create(
    input: CreateLiveChannelRequest,
    context?: { ownerId?: string }
  ): Promise<{ channel: PublicLiveChannel; publisher: PublisherConnectionDetails }> {
    const id = randomUUID();
    const path = `live-${opaqueToken(10)}`;
    const ingestPath = input.normalize ? `${path}-ingest` : path;
    const origin = await this.#selectOrigin(input.preferredRegion);
    const publishToken = opaqueToken(24);
    const publisher = this.#publisherConnectionDetails(ingestPath, publishToken);
    const channel: LiveChannel = {
      id,
      ...(context?.ownerId ? { ownerId: context.ownerId } : {}),
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
    const created = await this.repository.createLiveChannelWithinCapacity(channel, {
      maxTotal: this.options.maxChannelsTotal ?? 32,
      maxPerOwner: this.options.maxChannelsPerOwner ?? 4
    });
    if (!created.created) {
      if (created.reason === 'owner-not-found')
        throw new ConflictError('The user no longer exists');
      if (created.reason === 'owner-limit')
        throw new CapacityError('The user has reached the live-channel limit');
      throw new CapacityError('The installation has reached its live-channel limit');
    }
    this.metrics?.increment('live_channels_total', {
      outcome: 'created',
      normalize: String(input.normalize)
    });
    await this.#recordPublisherStates();
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
      if (result.applied) {
        this.metrics?.increment('live_publisher_replacements_total', { outcome: 'requested' });
        await this.#recordPublisherStates();
        return {
          channel: this.#publicChannel(result.record.value),
          publisher
        };
      }
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
      const credential = replacementMatches ? 'replacement' : 'primary';
      if (!replacementMatches && !primaryMatches) {
        this.#recordPublisherAuth('rejected', 'unknown', 'token');
        return false;
      }
      if (primaryMatches && stored.value.replacementPublishTokenHash) {
        this.#recordPublisherAuth('rejected', 'primary', 'replacement_pending');
        return false;
      }
      if (
        !replacementMatches &&
        (stored.value.publisherState === 'online' || stored.value.publisherState === 'reconnecting')
      ) {
        this.#recordPublisherAuth('rejected', 'primary', 'active_publisher');
        return false;
      }
      const previousState = stored.value.publisherState;
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
      if (result.applied) {
        this.#recordPublisherAuth('accepted', credential, 'none');
        if (previousState !== 'offline')
          this.metrics?.increment('live_publisher_reconnects_total', { credential });
        if (replacementMatches)
          this.metrics?.increment('live_publisher_replacements_total', { outcome: 'promoted' });
        await this.#recordPublisherStates();
        return true;
      }
      if (result.reason === 'not-found') {
        this.#recordPublisherAuth('rejected', credential, 'missing_channel');
        return false;
      }
      stored = result.current ?? (await this.repository.getVersionedLiveChannel(channelId));
    }
    this.#recordPublisherAuth('rejected', 'unknown', 'conflict');
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

  async list(filter?: { ownerId: string }): Promise<PublicLiveChannel[]> {
    return (await this.repository.listLiveChannels())
      .filter((channel) => !filter || channel.ownerId === filter.ownerId)
      .map((channel) => this.#publicChannel(channel));
  }

  #publicChannel(channel: LiveChannel): PublicLiveChannel {
    const sanitized = sanitizeLiveChannel(channel);
    const ingestPath = sanitized.ingestPath ?? sanitized.path;
    return publicLiveChannel({
      ...sanitized,
      rtmpUrl: `${this.options.rtmpUrl}/${ingestPath}`,
      srtUrl: `${this.options.srtUrl}?streamid=publish:${ingestPath}`,
      whipUrl: `${this.options.whipUrl}/${ingestPath}/whip`,
      ...(this.options.backupRtmpUrl
        ? { backupRtmpUrl: `${this.options.backupRtmpUrl}/${ingestPath}` }
        : {}),
      ...(this.options.backupSrtUrl
        ? { backupSrtUrl: `${this.options.backupSrtUrl}?streamid=publish:${ingestPath}` }
        : {})
    });
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
    if (this.normalizer) await this.normalizer.stop(channelId);
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
        this.metrics?.increment('live_publisher_state_transitions_total', {
          state
        });
      }
      if (!channel.normalize || !this.normalizer) continue;
      const profile = await this.#normalizationProfile(channel);
      if (!profile) {
        if (this.normalizer.running(channel.id)) await this.normalizer.stop(channel.id);
        continue;
      }
      if (
        online &&
        !this.normalizer.running(channel.id) &&
        (this.normalizer.canStart?.(channel.id, channel.ownerId) ?? true)
      ) {
        try {
          await this.normalizer.start(
            channel.id,
            channel.ownerId,
            `${this.options.internalRtspUrl}/${ingestPath}`,
            `${this.options.internalRtspUrl}/${channel.path}`,
            profile
          );
          this.metrics?.increment('live_normalizer_transitions_total', { state: 'running' });
        } catch (error) {
          this.metrics?.increment('live_normalizer_transitions_total', { state: 'failed' });
          this.events?.publish(
            event('live.normalizer.failed', {
              channelId: channel.id,
              reason: error instanceof Error ? error.name : 'unknown'
            })
          );
        }
      } else if (!online && this.normalizer.running(channel.id)) {
        await this.normalizer.stop(channel.id);
        this.metrics?.increment('live_normalizer_transitions_total', { state: 'stopped' });
      }
    }
    await this.#recordPublisherStates();
  }

  async #normalizationProfile(channel: LiveChannel): Promise<Profile | undefined> {
    if (channel.normalizationProfileId)
      return this.repository.getProfile(channel.normalizationProfileId);
    const session = (await this.repository.listSessions()).find((candidate) =>
      liveSessionOwnsChannel(candidate, channel.id)
    );
    if (!session) return undefined;
    return this.repository.getProfile(session.profileId);
  }

  async stop(): Promise<void> {
    if (!this.normalizer) return;
    const results = await Promise.allSettled(
      (await this.repository.listLiveChannels()).map((channel) => this.normalizer!.stop(channel.id))
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result): unknown => result.reason);
    if (failures.length)
      throw new AggregateError(failures, 'One or more live normalizers failed to stop');
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
    const channels = await this.repository.listLiveChannels();
    if (input.action === 'read' || input.action === 'playback') {
      if (
        this.options.allowUnauthenticatedInternalRead &&
        input.protocol === 'rtsp' &&
        !input.user &&
        !input.password &&
        !input.token
      )
        return channels.some((channel) => channel.normalize && channel.ingestPath === input.path);
      return (
        input.user === 'vrrelay-read' && (input.password === readToken || input.token === readToken)
      );
    }
    if (input.action !== 'publish') return false;
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

  #recordPublisherAuth(
    outcome: 'accepted' | 'rejected',
    credential: 'primary' | 'replacement' | 'unknown',
    reason:
      'none' | 'token' | 'replacement_pending' | 'active_publisher' | 'missing_channel' | 'conflict'
  ): void {
    this.metrics?.increment('live_publisher_auth_total', { outcome, credential, reason });
  }

  async #recordPublisherStates(): Promise<void> {
    if (!this.metrics) return;
    const counts: Record<LiveChannel['publisherState'], number> = {
      offline: 0,
      online: 0,
      reconnecting: 0,
      error: 0
    };
    for (const channel of await this.repository.listLiveChannels())
      counts[channel.publisherState] += 1;
    for (const [state, count] of Object.entries(counts)) {
      this.metrics.gauge('live_publishers', count, { state });
    }
  }
}
