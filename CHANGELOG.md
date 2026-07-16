# Changelog

All notable changes to VRRelay will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases will use
semantic versioning after the first public release.

## Unreleased

- Replaced the macOS installer package with a drag-to-Applications DMG. The signed app now carries
  the sealed runtime and installs or upgrades its system LaunchDaemon from the native menu after
  administrator approval; CI publishes a development DMG for every macOS run.
- Added explicit Jellyfin movie/show filtering and a series → season → episode picker before
  playable track selection, including hierarchical provider-contract and desktop/mobile browser
  coverage. Single HTTP `kinds` query values are normalized correctly at the API boundary.
- Rechecked all direct workspace packages and pinned Node, npm, FFmpeg, MediaMTX, Helm, Swift, and
  deployment versions against their authoritative releases; no additional stale dependency was
  found. The intentional TypeScript compatibility and SvelteKit Cookie pins remain documented.
- Refreshed the full runtime and deployment stack to FFmpeg 8.1.2, MediaMTX 1.19.2,
  npm 12.0.1, TypeScript 7.0.2, PostgreSQL 18, Valkey 9.1, the latest
  published MinIO community image, Debian 13, Swift 6.3, and the latest x264 revision.
- Added Microsoft's official TypeScript 6 compatibility package for API-dependent
  `typescript-eslint`, `svelte-check`, and OpenAPI tooling while project compilation uses
  TypeScript 7; replaced the forced Cookie 2 adapter with an API-compatible Cookie 0.7.2
  security override and narrowed the UUID 14 security override to the affected Google HTTP clients.
- Replaced the 144 MB Electron Windows tray runtime with a dependency-free Win32 C++
  controller that opens the dashboard, reports service state, and elevates only start, stop,
  and restart actions. The installer now starts it after installation and at user sign-in.
- Removed redundant Argon2, UUID, and unused
  ESLint/Prettier compatibility declarations.
- Made standalone and clustered Compose host ports configurable while preserving the
  existing defaults, and moved the PostgreSQL 18 volume to its required versioned layout.
- Simplified the macOS and Windows controllers to menu-bar/tray-only utilities with start, stop,
  restart, and system-browser dashboard actions; removed their embedded dashboard windows and
  native settings surface.
- Added authenticated runtime configuration controls to the dashboard for listener and advertised
  URLs, trusted proxies, agent networking, encoder/cache limits, node identity, provider health
  revalidation, and supervised service restart. Native macOS installs persist only allowlisted,
  non-secret values in a private runtime configuration file; orchestrated deployments remain
  read-only in the dashboard.
- Fixed relay placement in standalone mode: selecting **This node** no longer locks the dashboard,
  and the local source worker is now eligible for automatic placement without an agent connection
  to itself.

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
- Multi-host Compose role profiles with explicit service definitions and
  semantic checks for role-owned ports/listeners.
- Kubernetes migration-hook PostgreSQL wiring with writable migration backup
  storage and local template checks against SQLite fallback.
- Provider-neutral OpenTofu cloud-init rendering for role-specific VMs, with
  digest-pinned images, persistent node data/cache, MediaMTX sidecars, and
  post-enrollment join-token cleanup.
- Hardened PostgreSQL and SQLite backup/restore scripts with private atomic
  artifacts, schema validation, checksum/metadata sidecars, optional encryption,
  and rollback-backup enforcement before destructive restores.
- TLS front-door and image-pinning hardening for deployment artifacts, including
  internal/control path blocking, digest-required multi-host operational images,
  and digest-aware Helm relay/MediaMTX image rendering.
- Kubernetes network-policy and rollout hardening, including explicit relay
  egress CIDR blocks, scoped MediaMTX WebRTC UDP egress, operator-supplied
  runtime Secret rollout checksums, and bounded migration-hook deadlines.
- Native release-packaging guardrails that require macOS signing/notarization
  inputs, Windows signing inputs, runtime provenance, bundled notices/licenses,
  and a verified FFmpeg corresponding-source bundle for release-mode Windows
  packaging, with release workflow enforcement for those native release gates.
- A checksum-pinned, minimal headless macOS arm64 FFmpeg source builder with
  required-capability and MPEG-TS smoke checks, static third-party linkage,
  system-only dynamic dependency enforcement, build metadata, dependency
  licenses, and a complete per-file-checksummed corresponding-source archive.
- Fresh-runner Apple release wiring for temporary-Keychain certificate import,
  App Store Connect notarization credentials, hardened/timestamped nested
  signing, and unconditional credential cleanup.
- Publication metadata guardrails that keep security reporting, community files,
  release checklist repository gates, issue templates, and Dependabot coverage
  present before the public repository gate.
- Unit, integration, real-service smoke, deployment, and repository-check
  harnesses. Target services and destructive scenarios remain opt-in release
  evidence rather than default-unit-test guarantees.
- A dedicated TypeScript check for colocated test sources, included in the
  repository and CI check gate.
- A non-mutating OpenAPI client freshness check that detects changed, missing,
  and obsolete generated files without silently repairing CI state.
- Reusable fake/Jellyfin provider contracts and route-level HTTP security tests
  for setup/login cookies, CSRF, PAT scope/expiry/revocation, malformed requests,
  redaction, and playback-grant tamper/revocation/expiry behavior.
- Desktop/mobile Playwright administrator smoke coverage with Axe assertions,
  browser-error detection, a dedicated CI job, and retained failure artifacts.
- A separate unauthenticated `/api/v1/ready` endpoint that reports redacted,
  dependency-aware readiness distinct from `/api/v1/health` liveness.
- Low-cardinality aggregate viewer and egress metrics that avoid per-session
  Prometheus labels while keeping exact per-session state in the repository.
- Bounded cluster-node egress gauges from node heartbeat capability reports for
  controller-side per-node operations visibility.
- Low-cardinality worker queue, segment job, cache request, and object-store
  operation metrics for operational debugging without session/object-key labels.
- Low-cardinality live publisher state, publisher authentication/replacement,
  reconnect, and normalizer transition metrics without channel/path labels.
- Configurable object-store activation and an authenticated metrics webhook
  exporter with lifecycle, persistence-order, and delivery-health tests.
- Static traffic routing that can pin playback to a configured edge node or
  region without depending on an external routing webhook.
- Configurable bounded agent-log retention, capped node-log list queries, and
  redacted `node.log` events on the authenticated operations stream.
- Configurable bounded segment job-log retention, capped job-log list queries,
  redacted `job.log` events on the authenticated operations stream, and a
  dashboard log viewer for segment job lifecycles.
- Reproducible playlist, cached-egress, uncached-encode, live-fan-out,
  cache-ratio, and resource-snapshot benchmark scenarios with sanitized target
  metadata and host resource snapshots.
- Versioned retained benchmark reports with private atomic file publication,
  request-error enforcement, and comparable-baseline throughput/p95 regression
  gates for release evidence.
- Dedicated controller, source-worker, ingest-origin, edge, and standalone
  composition roots with explicit runtime dependency graphs, role-owned HTTP
  surfaces, schema-startup policy, and ordered shutdown.
- Immutable SQLite/PostgreSQL migration metadata through v7, complete physical
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

- Refresh the supported runtime and development toolchain to Node.js 26.5.0,
  npm 11.17.0, Electron 43.1.1, ESLint 10, and the current compatible package
  releases, with updated checksum-pinned native artifacts and CI coverage.
- Recast the README and implementation status as an audited prerelease
  inventory, removing unsupported feature-complete, target-validation, and
  production-readiness claims.
- Keep H.264 8-bit `yuv420p`, AAC-LC stereo, MPEG-TS HLS, and HTTPS as the
  intended production defaults while experimental formats remain unclaimed.
- Make the v1 completion ledger the authoritative source for phase status and
  retained verification evidence.
- Prepare the private GitHub publication surface with canonical repository and
  GHCR metadata, an expanded README/documentation index, current migration
  documentation, and an explicit distinction between remaining product work
  and external release qualification.
- Select the Swift 6.2 Xcode toolchain explicitly on GitHub's macOS 15 runners
  and keep release checksum generation shellcheck-safe on clean Linux runners.
- Provision checksum-pinned FFmpeg 7.1.5 runtimes across hosted Linux, macOS,
  and Windows checks instead of assuming runner state.
- Close SQLite test fixtures before cleanup and make atomic object metadata,
  PostgreSQL backup syncing, source-bundle parsing, and permission assertions
  portable across Windows hosted validation.
- Run branch validation through pull requests while limiting direct-push CI to
  `main`, avoiding duplicate hosted runs for Dependabot branches.
- Harden Git and Docker build-context exclusions for local environments,
  signing material, OpenTofu state, databases, media, test reports, IDE state,
  and native artifacts; remove stale design screenshots containing
  endpoint-, token-, or media-shaped sample data.
- Route dashboard requests through operation-specific generated OpenAPI
  functions, leaving only auth, CSRF, normalized errors, and domain-facing
  conveniences in the handwritten facade; guard against reintroducing literal
  API paths or generic generated-client requests.
- Add session stop/resume, pin/unpin, delete, details/output, and copy-link
  controls; placement preview with preferred region or exact locked worker;
  persisted navigation collapse; skip navigation; and mobile focus/Escape
  behavior.
- Preserve live-session kind across stop/resume, block stopped-session playback
  until resume, and exclude disconnected workers from placement preview and
  creation while preserving standalone placement.
- Require the production-build-backed desktop/mobile browser suite in release
  validation as well as CI.
- Build the provider-neutral workspace packages before the root check gate so a
  fresh `npm ci` checkout can validate the generated agent-protocol schema
  without relying on stale local `dist` output; use the same complete
  `npm run ci` gate in the operating-system CI matrix.
- Correct Helm IPv4/IPv6 CIDR rendering and avoid controller network-policy
  references to a disabled ingest origin; format and validate the provider-neutral
  OpenTofu module with the pinned local toolchain.
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
- Route controller-generated VOD and live playlists to edges with signed,
  session-scoped edge playback grants, so public edge URLs no longer reuse the
  administrator-facing controller token and session revocation invalidates
  already minted edge links.
- Aggregate salted viewer fingerprints through the coordination backend when
  available, including Valkey-backed 30-second edge/session counts while keeping
  egress bytes as exact counters.
- Track staged object-store backend application per node so one restarted role
  cannot clear restart-required status for the rest of the cluster.
- Record selected ingest-origin node and region metadata when creating live
  channels from available online origin nodes.
- Allow cache inventory and eviction requests to target a connected cluster
  node through strict agent envelopes, while failing closed for disconnected
  node targets.
- Let the cluster dashboard target local or connected source/edge node caches
  for inventory refreshes and bulk temporary-object eviction.
- Invalidate corrupt object-store segment restores and refill them through the
  normal generation/origin path instead of failing playback on stale completed
  job state.
- Delete referenced object-store entries when an administrator explicitly evicts
  matching temporary cache objects.
- Treat Azure Blob object deletion as idempotent so explicit cache eviction can
  reconcile objects that were already removed externally.
- Enforce disk cache limits immediately after segment writes and object-store
  restores while protecting the segment currently being served.
- Reconfigure and retry live edge origin pull paths once after failed HLS
  upstream responses instead of keeping stale MediaMTX path state pinned
  indefinitely, while coalescing concurrent viewer setup onto one edge path
  operation.
- Drive normalized live ingest from the selected immutable live profile and
  reject conflicting normalized profiles for the same live channel.
- Claim live publisher slots during MediaMTX publish authorization so duplicate
  publishers are rejected until reconciliation marks the channel offline.
- Let administrators issue replacement OBS publisher credentials without
  reopening old credentials for reconnects.
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

### Fixed

- Keep Safari and other WebKit clients from upgrading local plaintext dashboard
  assets to HTTPS, which previously left the packaged macOS dashboard blank.

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
- A real PostgreSQL dump/restore drill remains Phase 9–11 evidence.
- Full catalog navigation, live/binding/failover administration,
  dependency-management actions, certificate and metrics configuration,
  realtime dashboard updates, and exhaustive accessibility coverage remain
  product implementation gaps.
- Destructive distributed orchestration, media matrices, edge/live failure
  handling, deployment topologies, native installers, and supply-chain outputs
  remain release-qualification work.
- Real VRChat PC compatibility, Quest compatibility, clean-machine native
  installation, hosted cloud adapters, and destructive Kubernetes/cluster
  recovery are not currently supported release claims.
