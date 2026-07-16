# Private-production v1 implementation status

VRRelay is a prerelease foundation under repository reconciliation. The audited
checkout is not yet a feature-complete public release candidate and must not be
presented as a released or supported VRCDN replacement.

The authoritative progress record is the
[v1 completion ledger](v1-completion-ledger.md). A capability becomes a release
claim only when its owning phase has passed and links retained evidence. Older
local smoke results and the presence of CI, deployment, or packaging files are
not release evidence by themselves.

## Foundation present in the source tree

- A Node 22 TypeScript monorepo with provider-neutral domain/application
  packages, infrastructure adapters, a Fastify relay, and a SvelteKit operator
  dashboard.
- First-run administrator authentication, HTTP-only sessions, CSRF protection,
  scoped personal access tokens, opaque playback grants, structured profile
  validation, basic redaction, and provider URL policy.
- Jellyfin authentication, catalog/source mapping, ranged source access, and
  playback activity reporting on the implemented happy paths.
- Finite just-in-time HLS VOD, FFmpeg capability discovery, temporary segment
  caching, job coalescing, and MPEG-TS output as the intended production
  default. fMP4, fragmented MP4, H.265, AV1, and other experimental paths are
  not supported release claims.
- MediaMTX-backed RTMP, SRT, and WHIP ingest plus live HLS fan-out foundations.
- Outbound mTLS agent transport, node enrollment, role metadata, PostgreSQL,
  Valkey, filesystem/S3-compatible/Azure/GCS adapters, and a distributed
  acceptance harness.
- macOS, Windows, OCI, Compose, Helm, backup, release, SBOM, and provenance
  scaffolding, with native release-mode guardrails for signing, notarization,
  runtime provenance, and FFmpeg corresponding-source bundle presence.

These bullets inventory code and assets; they do not assert that every exposed
setting, failure mode, deployment topology, or administrator workflow is
complete.

## Phase 2 implementation and evidence

Phase 2 is complete. Its targeted SQLite/PostgreSQL evidence and full
pinned-runtime repository gate are green.

- Controller, source-worker, ingest-origin, edge, and standalone now dispatch
  through distinct composition roots with explicit dependency graphs,
  role-owned HTTP surfaces, schema-startup policy, and ordered shutdown tests.
- SQLite and PostgreSQL migrations now have immutable version/name/SHA-256
  metadata through v7. V4 adds live-channel revisions, v5 adds provider
  revisions/deletion state, v6 adds crash-safe binding deletion, and v7 adds
  bounded segment job logs. Startup
  validates exact columns, storage types, JSON/JSONB and timestamp shape,
  nullability, runtime-critical defaults, boolean checks, keys, unique
  constraints, and named indexes rather than trusting the migration number.
- Session, node, job, binding, setting, live-channel, and provider states now have
  insert/CAS primitives. Transactional guards keep live-session creation atomic
  with channel existence, VOD creation atomic with provider lifecycle, channel
  deletion atomic with publisher/session checks, and node removal restricted to
  revoked nodes without bindings.
- Provider binding setup stages a unique node-local token reference, atomically
  locks the expected provider and usable source-worker node, reconciles
  concurrent or replayed binding creation, deletes only a confirmed losing
  secret, and retains an ambiguous staged secret for later repair rather than
  risking a committed credential. Binding removal and provider removal are
  resumable mark/secret-delete/finalize flows protected from stale writes and
  new dependencies. Revoked-node orphan cleanup requires explicit administrator
  acknowledgement instead of silently claiming the node-local credential was
  removed.
- Administrative mutations write a redacted, correlated audit attempt before
  mutation and append a terminal result afterward. File-backed encrypted secret
  mutation uses per-path in-process serialization, restrictive permissions,
  synced unique temporary files, atomic rename, and parent-directory sync.
- Session CAS preserves immutable media/profile identity, and duplicate
  certificate serials fail consistently in SQLite and PostgreSQL.
- The final real PostgreSQL 17 matrix passed 49 of 49 tests, including
  two-connection CAS and transaction races. The complete pinned-runtime CI gate
  passed 235 tests with 23 intentional skips and no failures; format, generated
  client freshness, all typechecks, Svelte diagnostics, lint, builds,
  repository checks, and the zero-vulnerability npm audit also passed. See
  [Phase 2 evidence](evidence/phase-02.md).

## Phase 3 implementation checkpoint

Phase 3 has a build-first implementation checkpoint. Its final release
verification is still pending.

- Node enrollment now uses locally generated private keys, CSRs, single-use join
  tokens, and retry-safe pending CSR reuse after a lost response.
- Agent transport now uses outbound mTLS with strict versioned envelopes,
  bounded payloads, replay/timestamp/deadline enforcement, typed responses,
  connection-scoped cleanup, pending-request limits, and rate limits.
- Certificate rotation stages a replacement identity and activates it only after
  the node reconnects and proves possession with a timely hello. Staged proof is
  matched by certificate fingerprint so Node serial-number representation
  differences do not reject a valid replacement certificate.
- Drain intent is durable and controller-authoritative. Offline updates persist
  with `acknowledged: false`, and reconnect hello reconciles node-local state.
- Production configuration now fails closed for unsafe public/admin/playback,
  enrollment, and agent transport URLs; placeholder secrets; and ambiguous proxy
  trust. Dedicated roles expose only their owned HTTP surfaces.
- Jellyfin network policy now pins a validated DNS result to the outbound socket,
  blocks redirects, rejects metadata and private-bypass address forms, and keeps
  authenticated source access behind loopback grants with expanded redaction.
- OpenAPI, generated dashboard client, the agent protocol schema, deployment
  samples, environment docs, architecture docs, testing docs, and the changelog
  were updated. The local lean guardrails passed: focused agent transport tests,
  format check, generated-contract and TypeScript checks, lint, and build. See
  [Phase 3 implementation evidence](evidence/phase-03-implementation.md).

## Phase 4 implementation checkpoint

Phase 4 has a first build-first implementation checkpoint. Its broader
multi-node verification is still pending.

- Provider activity reporting now respects remote provider bindings. A
  controller-side service routes activity through the connected source worker
  that owns the node-local credential instead of trying to read that credential
  locally.
- Expired distributed segment jobs now close the latest running worker-history
  entry as failed before the job is requeued, preserving an auditable restart
  and retry trail.
- Focused provider-binding and crash-recovery tests, format check,
  generated-contract and TypeScript checks, lint, and package builds passed. See
  [Phase 4 implementation evidence](evidence/phase-04-implementation.md).

## Phase 5 implementation checkpoint

Phase 5 has a first build-first implementation checkpoint. Its broader media
matrix and real-client verification are still pending.

- New profile revisions now start as experiments. The create-profile path rejects
  manual verified state, low-latency delivery, RTSP, HTTP MPEG-TS, HLS event
  playlists, mismatched HLS segment/container settings, invalid fragmented-MP4
  shapes, and passthrough-policy profiles instead of accepting schema-only
  combinations the runtime cannot serve.
- The dashboard profile form now offers only implemented delivery shapes: HLS
  with matching MPEG-TS or fMP4 segments, and direct fragmented MP4 with no
  segment output.
- H.265, AV1, copy codecs, hardware-specific encoders, tone mapping, subtitle
  burn-in, fMP4/fragmented-MP4 concurrency, dual PC/Quest output claims, corrupt
  inputs, and real VRChat compatibility still require the retained Phase 9 and
  release-gate evidence. See
  [Phase 5 implementation evidence](evidence/phase-05-implementation.md).

## Phase 6 implementation checkpoint

Phase 6 has a first build-first implementation checkpoint. Its broader
edge-delivery and live-fan-out verification is still pending.

- Controller VOD playlists and live edge redirect playlists now exchange the
  administrator-facing playback token for a signed edge playback grant scoped to
  the selected edge node and session.
- Edge routes validate the signed grant against the durable playback grant on
  each request. Session deletion or grant revocation therefore invalidates
  already minted edge links instead of leaving edge URLs usable until process
  restart.
- Viewer aggregation now uses the coordination backend when configured: local
  coordination keeps rolling in-memory maps, Valkey coordination keeps
  30-second sorted sets by edge and session, session totals are updated from the
  aggregate, and exact egress byte counters remain separate.
- Object-store backend application is now recorded per node, so one restarted
  node no longer clears restart-required state for other roles that have not
  applied the staged backend configuration.
- Live channel creation now records the selected online ingest-origin node and
  region when cluster state is available, while preserving standalone/local
  channel creation when no cluster origin is recorded.
- Normalized live channels now pin the selected live-session profile, reject
  conflicting normalized profile choices for the same channel, and drive FFmpeg
  normalization from that profile's video and audio settings.
- Live publisher authorization now claims a channel slot before MediaMTX accepts
  a publisher. Duplicate publish attempts are rejected while the channel is
  online or reconnecting; primary or backup ingest URLs can publish again after
  reconciliation marks the channel offline.
- Administrators can intentionally issue replacement OBS credentials for a live
  channel. Once replacement is authorized, old credentials are refused for
  reconnects, the replacement token can claim the slot even during the prior
  `online`/`reconnecting` window, and public channel responses still omit all
  publisher token hashes.
- The cache administration API can target a connected node for inventory and
  eviction via strict agent envelopes and fails closed for disconnected targets
  instead of falling back to controller-local cache mutation.
- Corrupt object-store restores now invalidate the bad remote object and fall
  back to regeneration/origin refill, including completed segment jobs whose
  local output was evicted.
- Explicit cache eviction now removes both the local disk cache object and the
  referenced object-store entry for newly published or restored cache objects,
  while disk-pressure cleanup preserves the remote tier for later restore.
- Azure Blob deletion is idempotent like the local, S3, and GCS adapters, so
  explicit eviction can tolerate an external lifecycle policy or administrator
  having already removed the object.
- Segment generation and object-store restore enforce the configured disk cache
  limit immediately while protecting the requested segment from same-request
  eviction.
- Edge live playback drops cached MediaMTX path configuration after failed HLS
  upstream responses, reapplies the origin pull configuration, and retries the
  current request once. Concurrent viewers share one path setup promise for the
  active edge path instead of creating per-viewer setup operations.
- Focused application, adapter, backend, live-origin, and HTTP-boundary tests,
  format check, generated-contract and TypeScript checks, lint, package builds,
  and relay build passed. See
  [Phase 6 implementation evidence](evidence/phase-06-implementation.md).

## Phase 7 implementation checkpoint

Phase 7 has a first build-first implementation checkpoint. Its broader
administrator workflow, browser, accessibility, and realtime verification is
still pending.

- The cluster dashboard node cache panel can target the local cache or a
  connected source-worker/edge node for inventory and bulk eviction.
- The dashboard sends `nodeId` only for selected remote cache targets, falls
  back to local cache when the selected node disconnects or stops owning cache,
  and now labels the workflow as node cache instead of edge-only cache. See
  [Phase 7 implementation evidence](evidence/phase-07-implementation.md).

## Phase 8 implementation checkpoint

Phase 8 has a first build-first implementation checkpoint. Its broader
metrics, log streaming, routing, benchmarking, and operations evidence is still
pending.

- `/api/v1/health` remains a lightweight unauthenticated liveness endpoint with
  version, timestamp, and worker capacity.
- `/api/v1/ready` is now a separate unauthenticated readiness endpoint. It
  checks the backend health aggregate, returns HTTP 503 when a dependency is
  unhealthy or a staged backend change requires restart, and returns only
  redacted category/kind/healthy/timestamp dependency fields.
- The generated OpenAPI client includes the readiness operation and the route
  is covered by HTTP tests that verify status codes and redaction. See
  [Phase 8 implementation evidence](evidence/phase-08-implementation.md).
- Prometheus viewer and egress metrics no longer use unbounded session labels:
  egress is a total counter, viewer activity is an aggregate gauge, and
  `cluster_node_egress_mbps` exposes bounded per-node heartbeat egress while
  per-session truth remains in repository state/events instead of long-lived
  metric labels.
- Worker queue/pressure, segment job attempts/retries/failures/duration, disk
  and object-store cache requests, object operation latency/errors, and object
  restore outcomes now use bounded Prometheus labels; session IDs, object keys,
  URLs, and node IDs are not emitted as metric labels.
- Live publisher state, publisher authentication/replacement, reconnect, and
  normalizer transition metrics use bounded labels and avoid channel IDs,
  ingest paths, tokens, and URLs.
- The routing backend can now be switched between built-in hashing, static
  node/region routing, and the authenticated routing webhook through the
  backend service and cluster dashboard.
- Agent logs are redacted on receipt, retained per node with configurable row
  caps, bounded on list queries, and emitted as `node.log` events on the
  authenticated operations stream.
- The benchmark runner now has explicit playlist, cached-egress,
  uncached-encode, live-fan-out, cache-ratio, and resource-snapshot scenarios
  with sanitized target metadata and host resource snapshots.

## Known gaps in the audited checkout

- Phase 1 restored a clean local engineering baseline: format, lint, workspace
  and test-source typechecks, generated-client freshness, unit tests, builds,
  and the npm dependency audit pass under the pinned Node runtime. This is a
  baseline gate, not evidence for the unreached feature and deployment phases.
- A real PostgreSQL `pg_dump`/restore drill has not yet been retained; unit-tested
  backup invocation is not a substitute for the Phase 9–11 recovery and
  deployment evidence.
- Phase 3 still needs the final high-pass verification bundle: full pinned
  runtime CI, audit, multi-process destructive cluster evidence, public-WSS and
  overlay-WSS acceptance evidence, and deployment-target proof. The current
  Phase 3 record is an implementation checkpoint, not a release claim.
- Phase 4 still needs broader implementation and end-to-end gates for multi-node
  placement, distributed cancellation, restart recovery, provider failover, and
  provider-binding job flows across real controller/source-worker processes.
- Several media-profile fields and experimental delivery modes still need matrix
  evidence. Schema-only low-latency, RTSP, HTTP MPEG-TS, HLS event, mismatched
  segment/container, and passthrough-policy profile outputs are now blocked at
  profile creation, but hardware pipelines, H.265, AV1, copy codecs, subtitles,
  tone mapping, fMP4 concurrency, dual PC/Quest outputs, and corrupt-input
  handling still lack the required matrix evidence.
- Edge grants, coordination-backed viewer aggregation, selected-origin
  metadata, node-targeted cache administration, corrupt object-store restore
  recovery, immediate disk-pressure enforcement, and per-node backend
  application tracking now have implementation checkpoints. Destructive
  external object-store outage evidence and destructive multi-process origin
  recovery evidence remain Phase 6 work.
- The OpenAPI client is current and protected by a non-mutating freshness gate,
  but the dashboard still uses a handwritten request facade and has unfinished
  session, placement, catalog, live, binding, job, metrics, realtime,
  mobile, keyboard, and accessibility workflows.
- Adapter contracts, browser coverage, destructive cluster scenarios, and
  retained target-environment benchmark evidence remain release work.
- Multi-host Compose now has explicit role profiles and semantic render checks,
  and the Helm migration hook now forces PostgreSQL with writable migration
  backup storage. Provider-neutral OpenTofu now renders role-specific VM
  cloud-init with persistent data/cache, MediaMTX sidecars, digest-pinned image
  inputs, and post-enrollment join-token cleanup. PostgreSQL and SQLite
  backup/restore scripts now create private atomic artifacts, validate schema
  metadata, write checksum/metadata sidecars, support optional encryption, and
  enforce rollback backups before restore. TLS Compose now blocks public access
  to relay/MediaMTX internal control paths, multi-host Compose requires
  digest-pinned VRRelay/MediaMTX images for release-style rendering, and Helm
  relay plus MediaMTX workloads can render `repository@sha256:...`. Kubernetes
  runtime policies now use explicit egress blocks instead of unrestricted relay
  egress, externally managed Secret changes can drive pod rollouts through
  `rollout.runtimeSecretChecksum`, and the migration hook has an active
  deadline, but true multi-host boot evidence, rendered Helm/TLS behavior, final
  release digest selection, live backup/restore rehearsal, real cloud-VM boot
  evidence, native installers, signing/notarization,
  supply-chain evidence, upgrade/rollback, and clean-target installation have
  not passed their release gates.
- Native packaging release mode now fails closed when required macOS signing,
  installer-signing, notarization, Windows signing, or FFmpeg
  corresponding-source bundle inputs are missing. The checked-in native
  packaging guard also validates runtime manifest pins, notices/license
  inclusion, runtime provenance wiring, FFmpeg source recipe metadata, and the
  release workflow's release-mode/source-bundle handoff, but actual
  signed/notarized artifacts, clean-machine install/upgrade/uninstall evidence,
  final SBOMs, final vulnerability scans, and release attestations remain
  pending.
- Publication metadata is now guarded in CI: community files, the security
  policy, issue templates, public release checklist repository gates, and
  Dependabot coverage are checked by `script/check-repository.mjs`. Actual
  GitHub repository settings, branch protection, security feature enablement,
  public remote creation, and release publication remain Phase 12 gates.

## Release gates requiring target infrastructure or people

- Run the complete automated and destructive suites from a clean checkout on
  the supported operating systems and architectures, retaining logs, manifests,
  metrics, and checksums.
- Exercise standalone, true multi-host Compose, Kubernetes, public-WSS,
  overlay-WSS, TLS, backup, restore, upgrade, and rollback scenarios.
- Validate real Azure Blob and Google Cloud Storage services where those
  adapters are claimed.
- Install, upgrade, repair, reboot, recover, and uninstall the Windows and macOS
  artifacts on clean target machines; verify signing/notarization only with
  release credentials.
- Complete final artifact security scans, SBOMs, notices, checksums, provenance,
  attestations, and corresponding-source archives.
- Test the default H.264/yuv420p/AAC MPEG-TS VOD and OBS live paths in VRChat on
  PC over trusted HTTPS. Record Quest separately and claim it only after a real
  device passes.

No experimental codec or delivery method may become a production default from
automated FFmpeg success alone. The repository may be published only after the
feature-complete release-candidate gate passes; a supported v1 additionally
requires the target-environment and real-client evidence above.
