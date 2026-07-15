# Changelog

All notable changes to VRRelay will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases will use
semantic versioning after the first public release.

## Unreleased

This section describes a prerelease foundation that is still being reconciled.
It is not evidence that the repository, deployment targets, native packages, or
VRChat compatibility have passed their release gates. Verified progress and
retained evidence belong in the
[v1 completion ledger](docs/v1-completion-ledger.md).

### Added

- Provider-neutral domain and application packages, Jellyfin and FFmpeg
  adapters, a Fastify relay, and a SvelteKit operator dashboard.
- First-run administrator authentication, CSRF protection, scoped personal
  access tokens, opaque playback/source grants, structured profile validation,
  and basic secret/log redaction.
- Finite on-demand HLS VOD and MediaMTX-backed OBS live foundations, including
  temporary cache, job coalescing, outbound node agents, provider bindings, and
  edge routing happy paths.
- SQLite/PostgreSQL persistence, memory/Valkey coordination, and local,
  S3-compatible, Azure Blob, and GCS object-store adapters.
- Standalone, Compose, multi-host Compose, Helm, macOS, Windows, OCI, backup,
  release, SBOM, provenance, and corresponding-source scaffolding.
- Unit, integration, real-service smoke, deployment, and repository-check
  harnesses. Target services and destructive scenarios remain opt-in release
  evidence rather than default-unit-test guarantees.
- A dedicated TypeScript check for colocated test sources, included in the
  repository and CI check gate.
- A non-mutating OpenAPI client freshness check that detects changed, missing,
  and obsolete generated files without silently repairing CI state.
- Configurable object-store activation and an authenticated metrics webhook
  exporter with lifecycle, persistence-order, and delivery-health tests.
- Dedicated controller, source-worker, ingest-origin, edge, and standalone
  composition roots with explicit runtime dependency graphs, role-owned HTTP
  surfaces, schema-startup policy, and ordered shutdown.
- Immutable SQLite/PostgreSQL migration metadata through v6, complete physical
  schema-shape validation, revisioned create/CAS repository operations,
  transactional compound writes, and a shared two-connection concurrency
  suite.
- Append-only administrative audit attempts and terminal outcomes with
  correlated operation identifiers, bounded queries, and structured context
  redaction.
- Crash-consistent encrypted file-secret publication using serialized in-process
  mutations, unique synced temporary files, restrictive permissions, atomic
  rename, cleanup, and parent-directory sync.

### Changed

- Recast the README and implementation status as an audited prerelease
  inventory, removing unsupported feature-complete, target-validation, and
  production-readiness claims.
- Keep H.264 8-bit `yuv420p`, AAC-LC stereo, MPEG-TS HLS, and HTTPS as the
  intended production defaults while experimental formats remain unclaimed.
- Make the v1 completion ledger the authoritative source for phase status and
  retained verification evidence.
- Restore a green local engineering baseline under the checksum-verified pinned
  Node runtime while keeping later feature and deployment claims explicitly
  gated.
- Make provider/binding creation insert-only and transactional, reconcile
  concurrent or replayed attempts without deleting the winning node-local
  credential, and preserve ambiguous staged credentials for explicit repair.
- Add CAS publisher polling and guarded live-channel deletion so stale polls
  cannot resurrect deleted channels, and make live-session/channel plus
  VOD/provider dependency checks transactional.
- Make provider validation revisioned and deletion a resumable two-phase
  mark/secret-delete/finalize operation that blocks stale writes and new VOD
  work while pending.
- Make provider-binding deletion a durable begin/worker-secret-delete/finalize
  operation, exclude pending bindings from scheduling, and require explicit
  acknowledgement before finalizing an orphaned credential on a revoked or
  removed node.
- Route provider playback activity through the healthy connected remote binding
  when the credential belongs to a source worker, and mark expired distributed
  segment-job attempts as failed before requeueing them for recovery.
- Reject profile revisions that select delivery, passthrough, or compatibility
  states the runtime cannot currently serve, and narrow the profile form to
  implemented HLS and fragmented-MP4 delivery shapes.
- Require a revoked, binding-free node for physical removal and serialize
  provider-binding creation on a usable source-worker node plus the expected
  provider revision.
- Reject session CAS attempts that retarget immutable source/profile identity,
  and make duplicate certificate serials fail consistently across SQLite and
  PostgreSQL.
- Make controller/standalone the migration owners while dedicated data-plane
  roles perform a read-only schema-current assertion and fail closed on
  incompatible history.
- Verify the final Phase 2 slice with a 49-of-49 real PostgreSQL 17 matrix and
  the complete pinned-runtime CI gate: 235 passed, 23 intentional skips, zero
  failures, all builds/checks green, and zero npm vulnerabilities.

### Security

- Generate node private keys locally, enroll through CSRs and single-use join
  tokens, stage retry-safe certificate rotation 48 hours before expiry, and
  activate replacements only after certificate-bound reconnect proof.
- Replace loose agent payloads with a strict versioned protocol, bounded messages,
  sequence/deadline/replay enforcement, inbound rate limits, connection-scoped
  request cleanup, durable drain commands, and restart reconciliation.
- Add explicit production-mode transport validation, CIDR-scoped proxy trust,
  DNS-pinned Jellyfin requests with redirect blocking, comprehensive
  metadata/link-local address rejection, role-minimal HTTP surfaces, and FFmpeg
  failure redaction for internal grants, credentials, and private URLs. Legacy
  false-like `VRRELAY_TRUST_PROXY` values remain a no-op for upgrade safety;
  true or ambiguous values now fail closed.
- Keep provider credentials, node identities, playback grants, source URLs,
  backend secrets, certificates, and private media out of public contracts and
  repository fixtures.
- Preserve structured FFmpeg settings, shell-free process spawning, opaque
  internal source grants, URL policy checks, hashed enrollment/token records,
  and platform secret-store adapters as security foundations requiring broader
  Phase 3 and release-gate verification.
- Do not persist provider setup passwords or API keys at the controller. Remote
  setup may transiently pass through the controller, but the authenticated
  source worker exchanges it for a token held only in its node-local secret
  backend.

### Known limitations

- The audited repository has not yet passed the feature-complete public release
  candidate gate.
- A real PostgreSQL dump/restore drill remains Phase 9–11 evidence, and per-node
  acknowledgement of applied backend configuration remains Phase 6 work.
- Node transport hardening, distributed orchestration, media matrices,
  edge/live failure handling, dashboard workflows, observability, deployment
  topologies, native installers, and supply-chain outputs require the remaining
  reconciliation phases.
- Real VRChat PC compatibility, Quest compatibility, clean-machine native
  installation, hosted cloud adapters, and destructive Kubernetes/cluster
  recovery are not currently supported release claims.
