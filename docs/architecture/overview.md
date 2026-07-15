# VRRelay architecture

VRRelay is a centralized media relay, not peer-to-peer software. A Jellyfin VOD request follows this path:

```text
Jellyfin original source → bound source worker → FFmpeg → ObjectStore → edge disk cache → VRChat viewers
```

An OBS live request follows this path:

```text
OBS (RTMP/SRT/WHIP) → ingest origin / one normalizer → one pull per active edge → HLS viewers
```

One session/profile/window shares the same encoder jobs and segment cache. A simultaneous request for an identical segment joins the existing job. Independent seeks into different uncached windows can require separate bounded workers. Viewers never connect to one another; the relay host carries viewer egress.

## Boundaries

- `packages/domain` contains provider-neutral entities and validation only.
- `packages/application` owns use cases and ports. It knows no Jellyfin, FFmpeg, HTTP, database, or platform DTOs.
- `packages/adapters` implements Jellyfin, FFmpeg, SQLite/PostgreSQL, filesystem/S3/Azure/GCS object storage, Valkey coordination, platform secret stores, and network policy.
- `apps/relay` composes adapters and exposes `/api/v1`, `/play`, and internal loopback routes.
- `apps/web` consumes the versioned API. It does not import adapter types.
- `apps/macos` and `apps/windows` are service controllers and dashboard shells; relay business logic remains in TypeScript.

## Cluster roles

- The controller composition root owns the administrative API, dashboard, scheduler, enrollment, certificate authority, audit service, backend controls, and edge director. It does not expose source-worker, ingest-origin, or edge-only HTTP routes.
- The source-worker root owns the provider registry, node-local provider secrets, FFmpeg VOD processing, source proxy, and outbound node agent. It does not construct controller administration, certificate-authority, or live-ingest services.
- The ingest-origin root owns live ingest, optional normalization, MediaMTX, publisher reconciliation, and its outbound node agent. It does not construct provider or VOD-session services.
- The edge root owns playback, object restoration, local cache, metrics, and its outbound node agent. It uses a deliberately unavailable provider registry/transcoder boundary and cannot perform provider operations or local transcoding.
- Standalone intentionally composes all four responsibilities in one process while retaining the same application ports.

Standalone mode implements the same ports with SQLite, memory coordination, and the local filesystem. Cluster mode substitutes PostgreSQL, Valkey, and any configured object-store adapter without changing domain models.

Only controller and standalone startup may run migrations. Dedicated source-worker, ingest-origin, and edge processes perform a read-only schema-current assertion and fail closed on missing, incomplete, future, gapped, or tampered history.

## Persistence and concurrency

SQLite and PostgreSQL share the same provider-neutral repository contract. Migration definitions have fixed version, name, and SHA-256 metadata through v5. Existing v1/v2 databases are the only accepted metadata-free legacy history; their known metadata is backfilled inside the locked v3 migration transaction after the configured backup gate. Immutable v4 adds live-channel revisions, and v5 adds provider revisions plus a durable deletion-pending marker. Changed definitions, future versions, gaps, partial metadata, and name/checksum tampering are rejected at startup.

History alone is not considered sufficient. Both adapters verify the complete expected schema shape, including every required table and column, primary keys, required unique constraints, and named index column order.

The runtime uses insert-only creation and revisioned compare-and-set operations where stale document writes would lose state:

- session state/viewer updates;
- node heartbeat, drain, offline, certificate rotation, and terminal revocation;
- segment-job lease and terminal completion/cancellation;
- provider-binding state while binding ownership remains immutable;
- live-channel publisher polling and guarded deletion;
- provider validation/metadata and terminal deletion;
- first-run settings such as the administrator password hash and viewer-estimation salt.

Compound ownership changes are transactional: session plus playback grant, session deletion plus grant revocation, node plus initial certificate, certificate rotation/revocation, provider plus node binding, live-channel deletion, and provider deletion transitions. The same concurrency suite runs against two independent SQLite connections and real PostgreSQL connections.

Live-session creation locks/checks the referenced channel revision in the same transaction as the session and playback grant. Channel deletion locks the channel and succeeds only while the publisher is offline and no session references it; a stale MediaMTX poll therefore cannot resurrect a deleted channel. VOD creation similarly checks that its provider exists and is not deletion-pending, while provider deletion checks for both VOD sessions and bindings.

Provider deletion is an insert/CAS-backed, resumable two-phase flow. The repository first marks a dependency-free provider deletion-pending, making it invisible to active reads and stale validation. The service then removes its secret idempotently and CAS-finalizes deletion only after rechecking dependencies. A failed secret deletion leaves the durable marker in place so a later request resumes safely.

## Provider credential boundary

Provider setup is a transient credential exchange, not a claim that the controller never sees a password. For a remote binding, the controller may receive the setup request and forward its username/password or API key over the authenticated node channel. It never stores those setup credentials. The selected source worker authenticates with Jellyfin, immediately stages the returned token in its node-local secret backend, then atomically creates provider metadata and the binding.

Binding identifiers are insert-only and ownership fields cannot be changed through CAS. Creation serializes on the target node and provider: the node must exist, be an unrevoked source worker, and the provider must match its expected revision/server and not be deleting. Concurrent/replayed creation reconciles to the committed binding and removes only the losing staged secret. If commit status cannot be read safely, the worker retains the staged credential for later reconciliation instead of risking deletion of a committed secret.

Node removal follows the same dependency discipline. It requires the expected revision, a terminal `revoked` state, and no provider bindings; binding creation cannot target a missing, revoked, or non-source-worker node.

The encrypted file backend serializes mutations within the process, writes a synced unique temporary file with restrictive permissions, atomically renames it, and syncs the parent directory. Platform Keychain/DPAPI backends remain separate adapters. Cross-process file locking is not claimed.

## Administrative audit

Administrative mutations are wrapped in a durable, append-only audit sequence. An attempt record with sensitive context keys redacted must persist before the mutation begins. A correlated success, failure, or denial record follows the operation. Terminal audit-write failure is surfaced to operational reporting but does not misrepresent an already committed one-time result as rolled back. Audit queries are authenticated and bounded; callers must continue to avoid putting secret values in free-form messages or nonsensitive context fields.

Plex or Emby support is added by implementing `MediaProvider`. New delivery engines implement `Transcoder` or a future delivery port without changing public provider models.

Per-node acknowledgement of an activated object-store/backend configuration is not part of these persistence guarantees; it remains Phase 6 edge-delivery work. Likewise, the migration backup hook and its redaction/atomic-publication unit tests do not constitute a real PostgreSQL `pg_dump` plus restore drill. That evidence remains in Phases 9–11.

## VOD timeline

The HLS manifest is finite on its first response: it declares `PLAYLIST-TYPE:VOD`, every planned segment duration, and `ENDLIST`. This gives a compatible player a finite duration and seekable segment timeline. The player maintains its own current position; that value is not supplied by the manifest. VRRelay does not synchronize viewers. A VRChat world distributes the URL and playback time and seeks clients as needed.

No permanent alternate rendition is generated. Segments are created on demand, written atomically, reused temporarily, and evicted after idle expiry. Pinned sessions keep their playback URL and configuration, not media data or workers.

See the [code map](code-map.md) for entry points and change boundaries.
