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
  scaffolding.

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
  metadata through v6. V4 adds live-channel revisions, v5 adds provider
  revisions/deletion state, and v6 adds crash-safe binding deletion. Startup
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
- Several media-profile fields and experimental delivery modes are incomplete
  or schema-only. Hardware pipelines, subtitles, tone mapping, passthrough,
  fMP4 concurrency, dual PC/Quest outputs, and corrupt-input handling lack the
  required matrix evidence.
- Edge grants/revocation, viewer aggregation, targeted cache administration,
  live backup/replacement behavior, origin recovery, and one-pull-per-edge
  guarantees are incomplete. Backend configuration does not yet track
  per-node applied acknowledgement; that belongs to Phase 6 and must not be
  inferred from the current controller-level activation record.
- The OpenAPI client is current and protected by a non-mutating freshness gate,
  but the dashboard still uses a handwritten request facade and has unfinished
  session, placement, catalog, live, binding, job, cache, metrics, realtime,
  mobile, keyboard, and accessibility workflows.
- Readiness, low-cardinality operational metrics, bounded structured logs,
  adapter contracts, browser coverage, destructive cluster scenarios, and
  reproducible benchmark evidence remain release work.
- Multi-host Compose, Kubernetes migration/TLS behavior, cloud-neutral VM
  provisioning, native installers, signing/notarization, supply-chain evidence,
  upgrade/rollback, and clean-target installation have not passed their release
  gates.

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
