# VRRelay architecture

VRRelay is a centralized media relay, not peer-to-peer software. A Jellyfin VOD request follows this path:

```text
Jellyfin original source → bound source worker → FFmpeg → ObjectStore → edge disk cache → VRChat viewers
```

An OBS live request follows this path:

```text
OBS (RTMP/SRT/WHIP) → ingest origin / one normalizer → one pull per active edge → HLS viewers
```

One VOD session has one durable source producer generation. Its assigned source worker owns one
logical Jellyfin source pull, publishes atomically completed segments to shared object storage, and
serves every regional edge from that shared output. A seekable container may issue several
overlapping metadata and media HTTP ranges while FFmpeg probes the source; those requests are
tracked independently and are all fenced by the producer generation signal. Only an explicit
generation stop, failover, or dominant seek cancels them. Adjacent and simultaneous demand joins
the current playback window. A distant position replaces it only when it has more active viewers,
or when the old window has gone quiet; ties retain the current producer. The coordinator compares
viewer demand with the accepted playback window rather than the encoded head, because the latter is
intentionally ahead while the low-watermark buffer fills. Viewer disconnects detach only their
segment wait; they never cancel the shared producer. Viewers never connect to
one another, so this is CDN-style edge fan-out rather than peer-to-peer delivery.

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
- Standalone intentionally composes all four responsibilities in one process while retaining the
  same application ports. Local work dispatch stays in-process, so the default install does not
  start the cluster agent listener or provision cluster certificates.

Standalone mode implements the same ports with SQLite, memory coordination, and the local filesystem. Cluster mode substitutes PostgreSQL, Valkey, and any configured object-store adapter without changing domain models.

Only controller and standalone startup may run migrations. Dedicated source-worker, ingest-origin, and edge processes perform a read-only schema-current assertion and fail closed on missing, incomplete, future, gapped, or tampered history. Source workers reconcile expired producer leases after schema validation but never mutate the migration history.

## Persistence and concurrency

SQLite and PostgreSQL share the same provider-neutral repository contract. Migration definitions have fixed version, name, and SHA-256 metadata through v9. Existing v1/v2 databases are the only accepted metadata-free legacy history; their known metadata is backfilled inside the locked v3 migration transaction after the configured backup gate. Immutable v4 adds live-channel revisions, v5 adds provider revisions plus a durable deletion-pending marker, v6 adds durable provider-binding deletion, v7 adds bounded segment-job logs, v8 adds unified user identities, and v9 adds fenced durable VOD producer state and indexes. Changed definitions, future versions, gaps, partial metadata, and name/checksum tampering are rejected at startup.

History alone is not considered sufficient. Both adapters verify the complete expected schema shape, including every required table and column, primary keys, required unique constraints, and named index column order.

The runtime uses insert-only creation and revisioned compare-and-set operations where stale document writes would lose state:

- session state/viewer updates;
- node heartbeat, drain, offline, certificate rotation, and terminal revocation;
- segment-job lease and terminal completion/cancellation;
- VOD producer ownership, generation, demand window, lease, and stale-generation fencing;
- provider-binding state while binding ownership remains immutable;
- live-channel publisher polling and guarded deletion;
- provider validation/metadata and terminal deletion;
- first-run settings such as the administrator password hash and viewer-estimation salt.

Compound ownership changes are transactional: session plus playback grant, session deletion plus grant revocation, node plus initial certificate, certificate rotation/revocation, provider plus node binding, live-channel deletion, and provider deletion transitions. The same concurrency suite runs against two independent SQLite connections and real PostgreSQL connections.

Live-session creation locks/checks the referenced channel revision in the same transaction as the session and playback grant. Channel deletion locks the channel and succeeds only while the publisher is offline and no session references it; a stale MediaMTX poll therefore cannot resurrect a deleted channel. VOD creation similarly checks that its provider exists and is not deletion-pending, while provider deletion checks for both VOD sessions and bindings.

Provider deletion is an insert/CAS-backed, resumable two-phase flow. The repository first marks a dependency-free provider deletion-pending, making it invisible to active reads and stale validation. The service then removes its secret idempotently and CAS-finalizes deletion only after rechecking dependencies. A failed secret deletion leaves the durable marker in place so a later request resumes safely.

## Provider credential boundary

Provider setup is a transient credential exchange, not a claim that the controller never sees a password. For a remote binding, the controller may receive the setup request and forward its username/password or API key over the authenticated node channel. It never stores those setup credentials. The selected source worker authenticates with Jellyfin, immediately stages the returned token in its node-local secret backend, then atomically creates provider metadata and the binding.

Interactive sign-in uses one selected delegated provider connection that contains endpoint metadata
but no shared administrator credential. Each Jellyfin user authenticates through the provider
adapter and sees only that account's catalog. The provider/user identity hash is persisted with
explicit local roles and profile entitlements. User-created VOD sessions copy the user's provider
token into a controller-side session-owned secret, record only the stable owner identity in
provider-neutral metadata, and remove the secret with the session. In a cluster the controller
sends that token only in the typed sensitive `producer.start` payload over mTLS to the selected
compatible source worker. The worker holds it in memory for the producer lifetime and discards it
on stop, lease loss, disconnect, or process exit.

Jellyfin users may also create OBS channels and live playback sessions. Live-channel ownership is
assigned from the authenticated principal on the server: users can list, rotate, and delete only
their own channels, while operators and higher roles receive the system-wide view. The owner field
is not exposed in public live-channel summaries.

Portal discovery searches only top-level movies and shows. Selecting a show performs account-scoped
season and episode browsing before a playable source can be selected. Provider artwork is streamed
through an authenticated VRRelay endpoint so the browser never receives a provider access token or
private provider URL.

Binding identifiers are insert-only and ownership fields cannot be changed through CAS. Creation serializes on the target node and provider: the node must exist, be an unrevoked source worker, and the provider must match its expected revision/server and not be deleting. Concurrent/replayed creation reconciles to the committed binding and removes only the losing staged secret. If commit status cannot be read safely, the worker retains the staged credential for later reconciliation instead of risking deletion of a committed secret.

Node removal follows the same dependency discipline. It requires the expected revision, a terminal `revoked` state, and no provider bindings; binding creation cannot target a missing, revoked, or non-source-worker node.

The encrypted file backend serializes mutations within the process, writes a synced unique temporary file with restrictive permissions, atomically renames it, and syncs the parent directory. Platform Keychain/DPAPI backends remain separate adapters. Cross-process file locking is not claimed.

## Administrative audit

Administrative mutations are wrapped in a durable, append-only audit sequence. An attempt record with sensitive context keys redacted must persist before the mutation begins. A correlated success, failure, or denial record follows the operation. Terminal audit-write failure is surfaced to operational reporting but does not misrepresent an already committed one-time result as rolled back. Audit queries are authenticated and bounded; callers must continue to avoid putting secret values in free-form messages or nonsensitive context fields.

The domain and application ports accept provider identifiers without enumerating a vendor. Adding
Plex, Emby, or another provider still requires an adapter plus explicit contract, authentication,
composition, and dashboard integration because the current public setup/sign-in surface is
deliberately Jellyfin-specific. New delivery engines require a structured delivery port and
validated public contract; a `Transcoder` implementation alone is not a product integration.

Activated object-store/backend configuration records per-node application state so one restarted role cannot clear restart-required status for other roles. The migration backup hook and its redaction/atomic-publication unit tests still do not constitute a real PostgreSQL `pg_dump` plus restore drill. That evidence remains in Phases 9–11.

## VOD timeline

The HLS manifest is finite on its first response: it declares `PLAYLIST-TYPE:VOD`, every planned segment duration, and `ENDLIST`. This gives a compatible player a finite duration and seekable segment timeline. The player maintains its own current position; that value is not supplied by the manifest. VRRelay does not synchronize viewers. A VRChat world distributes the URL and playback time and seeks clients as needed.

No permanent alternate rendition is generated. The producer starts at the demanded segment and
uses a low/high watermark buffer. By default it catches up at up to approximately 2× while
headroom is at or below 30 seconds, backpressures the same source connection at 60 seconds, and
does not resume catch-up until the low watermark is reached. Both watermarks are configurable and
the hysteresis prevents rapid pacing oscillation. Headroom is measured from the completed segment
timeline against a one-speed playback clock anchored when the producer generation starts. Segment
requests remain demand and seek evidence; an eager player downloading every available segment does
not collapse measured playback headroom to zero. It stops after 60 seconds without demand by
default (configurable from 15–600 seconds).
Each source worker admits at most the configured global and per-provider producer limits (default
two, bounded by its worker capacity). A distant playback window must win the active-viewer
majority before a replacement generation is started; replacements are not artificially delayed.
Session runtime
snapshots include the upstream connection count and recent source-request attempts, while regional
edges continue to serve the shared object-store segments without opening another provider connection.
Segments are written atomically, reused temporarily, and evicted after cache expiry. Pinned
sessions keep their playback URL and durable producer recovery metadata, not permanent media or a
permanently running worker.

The durable producer applies to HLS VOD profiles, including MPEG-TS and fMP4-segmented HLS.
Direct fragmented-MP4 delivery has been removed from the domain, API, dashboard, and transcoder
surface. Any future CMAF/fMP4 delivery path must use shared admission, isolate viewer backpressure
and late joins, and reuse one fenced upstream producer before it can become a public profile method.

Producer generations keep timestamps on the manifest's absolute media timeline. A distant seek is
performed against the seekable opaque loopback source, and the replacement producer offsets both
MPEG-TS and fMP4 output timestamps to its requested start. Deterministic cache identity includes a
pipeline epoch so segments produced under an incompatible timestamp policy are never mixed.

See the [code map](code-map.md) for entry points and change boundaries.
