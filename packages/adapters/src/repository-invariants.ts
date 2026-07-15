// SPDX-License-Identifier: GPL-3.0-or-later
import type { MediaSourceRef, RelaySession } from '@vrrelay/domain';

function sameMediaSource(
  current: MediaSourceRef | undefined,
  candidate: MediaSourceRef | undefined
): boolean {
  if (!current || !candidate) return current === candidate;
  return (
    current.providerId === candidate.providerId &&
    current.itemId === candidate.itemId &&
    current.versionId === candidate.versionId &&
    current.sourceFingerprint === candidate.sourceFingerprint &&
    current.audioTrackId === candidate.audioTrackId &&
    current.subtitleTrackId === candidate.subtitleTrackId
  );
}

export function sameSessionIdentity(current: RelaySession, candidate: RelaySession): boolean {
  return (
    current.id === candidate.id &&
    current.kind === candidate.kind &&
    sameMediaSource(current.source, candidate.source) &&
    current.liveChannelId === candidate.liveChannelId &&
    current.profileId === candidate.profileId &&
    current.profileRevision === candidate.profileRevision &&
    current.platformMode === candidate.platformMode &&
    current.durationSeconds === candidate.durationSeconds &&
    current.createdAt === candidate.createdAt
  );
}
