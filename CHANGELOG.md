# Changelog

All notable changes to VRRelay will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases will use
semantic versioning after the first public release.

## Unreleased

- Fixed HLS prefetches and interleaved viewer requests being mistaken for user
  seeks. A distant segment request now requires a following request in the
  same playback window before it can move the VOD producer's pacing anchor.
- Fixed VOD catch-up stalls by treating requests ahead of the encoded head as
  waiters rather than repeatedly replacing the active FFmpeg producer. Built-in
  profiles now select an available H.264 hardware encoder per worker (including
  VideoToolbox), with portable software fallback, and automatic decode lets
  FFmpeg use the worker's available accelerator.
- Consolidated the pending runtime, development, and GitHub Actions dependency
  updates. The SvelteKit 3 prerelease migration now uses its `$app/tsconfig`
  layout through the existing TypeScript compatibility boundary, and
  `better-sqlite3` 13 uses its reviewed bundled platform binaries without an
  unnecessary source build. macOS, Windows, and OCI packaging now retain only
  the target platform's SQLite prebuild before signing or copying the runtime.
  Native Linux npm installs require glibc 2.34 or newer; the Debian trixie
  container path remains compatible.
- Replaced per-version GitHub release tags with one GitHub Actions-managed lightweight `latest`
  tag and release. Product build 100 seeds the explicit build-number sequence; every workflow
  attempt appends collision-safe, build-numbered native packages, source archives, metadata,
  checksums, and a manifest without overwriting history. OCI builds are staged by immutable digest
  and roll only `latest` after the completed release publishes, while manifests retain historical
  image digests. Selective failed-job retries reuse the gate-authored identity, and release
  publication moves the lightweight ref only after all assets exist so workflow-changing builds
  remain retryable. Interrupted zero-byte GitHub upload placeholders are removed only when their
  exact build asset is retried; completed assets stay append-only. Release metadata now packages a
  Helm chart pinned to the same immutable OCI digest, while the source chart falls back to the only
  mutable tag the workflow publishes: `latest`. Public releases also require an anonymous pull of
  the staged digest so a default-private GHCR package cannot produce an unusable chart. Release
  checks fail closed on asset collisions, release immutability, source-revision drift, signing
  failures, or the archive safety threshold.
- Hardened native release signing on both desktop platforms. macOS signs every nested Mach-O with
  the same Developer ID, gives the directly launched Node runtime only its required JIT
  entitlements, retains library validation, and executes the packaged SQLite and Argon2 add-ons
  before notarization. Windows now checks every native tool exit, signs and verifies nested
  executables, DLLs, and Node add-ons, and refuses a missing or unsigned final installer.
- Made production media behavior portable across macOS, Windows, and Linux. Every packaged FFmpeg
  binary must report the exact shared source revision, automatic decode remains software on every
  host, and built-in profiles now use `libx264`/software instead of selecting a host-specific
  hardware encoder. Untouched hardware-selected built-in revision 1 profiles receive a portable
  revision 2; custom accelerated profiles remain explicit opt-ins.
- Added administrator-configured inactivity deletion for unpinned sessions and stale ordinary-user
  purging, both disabled by default. Successful media delivery refreshes session activity,
  deletion-pending cleanup is retried without a restart, protected or resource-owning users cannot
  starve later purge candidates, and owners can manually delete eligible accumulated users from the
  dashboard.
- Persisted a non-secret index for browser-session provider credentials so logout, expiry, restart
  recovery, and user deletion can reliably remove Keychain, DPAPI, or encrypted-file secrets.
  Login, cleanup, and deletion are serialized so no race can publish an orphan credential or
  browser session.
- Fixed transient HLS freezes after seeks and producer buffer cycles by aligning FFmpeg's initial
  source-read allowance with the configured high watermark. This keeps FFmpeg's 2× safety ceiling
  from competing with the application watermark pacer. A generation-local progress watchdog now
  restarts only a catching-up producer that has already published, has a pending segment response,
  and then stops publishing for a bounded grace period; buffered and unobserved producers are left
  alone.
- Stopped and awaited active FFmpeg VOD producers when segment publication fails, preventing
  orphaned transcoders and scratch-directory races during recovery.
- Fixed long-running Jellyfin VOD source pulls being reset by the metadata request timeout after
  their response had already opened. Media streams now retain producer cancellation while the
  30-second timeout applies only to resolving and opening the upstream response.
- Kept persistent VOD producers alive while segment responses are still waiting for publication,
  preventing a slow in-flight segment from being mistaken for an idle stream. Normal idle shutdown
  resumes as soon as the last waiter finishes or disconnects.
- Stopped pending segment requests from restarting a VOD producer after its durable session was
  deleted or stopped, preventing orphaned generations from repeatedly requesting a removed
  session-owned source credential.
- Hardened persistent VOD producer recovery: truncated code-zero transcodes now fail unless they
  publish through the terminal segment, immediate failures use shared bounded retry backoff, and
  pending starts plus remotely deleted or stopped sessions are fenced before they can keep sourcing
  media. Pending segment responses now keep their owning producer generation alive until they
  finish, disconnect, or time out, avoiding an idle restart while a viewer is still waiting.
  Dashboard stops now reach the durable remote producer owner after failover, and seek arbitration
  scales its forward join window with the profile's actual segment duration. A controller restart
  now drains active source-worker producers without permanently closing their reusable coordinator,
  so the reconnected worker can serve the next segment immediately.
- Bound the standalone Compose administration port to loopback by default so
  the localhost first-run policy cannot expose owner setup to LAN clients.
  Standalone VOD placement now refreshes local provider capabilities
  synchronously, eliminating the transient `preferred-node-unavailable`
  response immediately after creating a provider.
- Remediated the repository-wide production-readiness audit: owner demotion is now one transactional
  set invariant; producer reservations and scratch storage are released and accounted; grant-bearing
  media is non-cacheable; direct fragmented MP4 was removed; live channels and normalizers have
  global and per-owner quotas plus restart supervision; Kubernetes readiness targets dependency
  readiness; edge grants,
  viewer affinity, media validation, outbound timeouts, startup rollback, aggregate shutdown, and
  media-aware rate limiting now enforce their intended boundaries. Dedicated roles expose
  dependency-aware readiness and bind public HTTP only after their critical local resources start;
  stale live edge paths are deleted from MediaMTX and later recreated on demand. Dashboard
  creation, diagnostics, mobile navigation, one-time credentials, destructive actions, token
  expiry, advanced relay handoff, status styling, typography, and route titles were made
  failure-safe and reachable. Connections can now explicitly create either delegated sign-in
  endpoints or administrator-managed user-token/API-key endpoints needed by the advanced placement
  workflow. Jobs expose bounded logs plus confirmed cancellation, and revoked binding-free node
  records can be removed through a dedicated confirmation.
- Clarified the unified sign-in form so the local recovery-owner path and its
  Argon2id verification are explicit without misrepresenting the recovery
  password as an unpersisted provider credential. Contract checks now include
  PUT, dedicated role routes, and core OpenAPI/domain semantics.
- Hardened the final distributed-runtime boundaries found by acceptance
  testing. Signed edge grants are bounded at the router, dedicated roles finish
  enrollment and use the durable enrolled node identity before composing
  node-scoped services, controller disconnects abort every command accepted on
  that transport link, and session deletion resolves the current durable
  producer owner before requesting cleanup. The acceptance fixture now measures
  source overlap at connection open, accounts actual scratch-file bytes rather
  than directory metadata, restores drained edges before live fan-out, and
  emits redacted per-worker cleanup diagnostics.
- Pinned patched transitive releases for `fast-uri`, `fast-xml-parser`,
  `@nodable/entities`, `brace-expansion`, `js-yaml`, and `find-my-way`, and
  upgraded `@fastify/static` to its patched release. Clean npm 12 installs
  accept the exact lockfile, the full repository gate and online audit report
  zero vulnerabilities, and the production OCI, standalone Compose, cluster
  Compose, and local multi-process cluster smoke tests pass.
- Stabilized persistent HLS VOD after seeks. Producers no longer use a short, independent FFmpeg
  read-rate burst that can stall before the application buffer is full; demand selection now uses
  the active playback window rather than the deliberately buffered encoded head; individual client
  disconnects no longer cancel a warming shared producer; fMP4 initialization is stored under one
  deterministic key even for a direct nonzero seek; and terminal producer history is capped to
  protect the runtime and dashboard.

- Fixed Jellyfin catalog search presentation so discovery rows are hidden while a search is active,
  results are clearly labeled, and stale responses cannot replace the latest query.
- Added configurable 30/60-second low/high HLS VOD producer buffer watermarks. Producers catch up
  at up to approximately 2×, backpressure the existing Jellyfin connection at the high watermark,
  and resume only after headroom falls to the low watermark. Session diagnostics now distinguish
  catching-up and buffered producer states. Headroom follows the producer generation's one-speed
  playback clock, so eager HLS segment requests no longer pin the displayed lead at zero or prevent
  the producer from reaching its configured buffer target.
- Added Jellyfin home rows for Continue Watching, Up Next, and Recently Added, including saved
  progress metadata. Catalog discovery now excludes virtual, missing, placeholder, and empty
  movie/show entries that have no playable media file. Administrators can now disable Jellyfin
  playback reporting globally for signed-in-user VOD sessions; VRRelay viewer and session
  diagnostics remain active when provider reporting is disabled.
- Fixed native/standalone OBS publisher details advertising loopback MediaMTX hosts after a public
  relay hostname was configured. Default RTMP, SRT, and WHIP endpoints now use the public hostname,
  while explicit non-loopback ingest endpoints remain authoritative and existing channel summaries
  are re-advertised from current configuration.
- Added upstream VOD visibility to session diagnostics: active source connections and source request
  attempts in the last 30 seconds are shown alongside ingress and egress. Added bounded producer
  admission (global and per-provider) to protect Jellyfin and bound local producer resource use.
  These controls are provider-neutral and apply to every HLS VOD source worker. Distant seek
  replacement is deliberately not rate-limited so legitimate scrubbing remains immediate.
- Added a profile-level default audio language for multi-track VOD. VRRelay selects the preferred
  language (ISO 639-2 or BCP-47) before the provider's default track, while an explicit track choice
  always wins.
- Added live per-session delivery diagnostics to the Sessions dashboard: privacy-preserving viewer
  estimates, producer activity, playback window and buffer lead, transcode realtime factor, source
  ingress, viewer egress, and delivery-cache effectiveness. Runtime snapshots are short-lived and
  do not add session IDs to Prometheus labels.
- Fixed distant VOD seeks freezing. Jellyfin static streams now remain seekable through HTTP Range,
  FFmpeg probe and media ranges are tracked independently instead of aborting one another,
  replacement HLS producers preserve absolute MPEG-TS and fMP4 timestamps, and the cache pipeline
  epoch prevents reuse of older reset-timestamp segments. Source-range logs now include a request
  identifier and producer generation so probe failures can be distinguished from real seeks.
- Fixed explicit LAN listener configurations failing local source grants by starting a private
  loopback companion for internal media routes. Quitting the macOS menu or Windows tray now waits
  for the managed relay runtime to stop before the controller exits.
- Added privacy-safe playback diagnostics with stable per-process client trace IDs, start/resume/
  retry/seek classification, regional edge decisions, serialized source-range transitions, and
  semantic API mutation outcomes. Runtime settings can switch between normal operational logging
  and detailed per-request playback tracing; tokens, raw client addresses, user agents, request
  bodies, source URLs, and provider credentials remain excluded.
- Fixed persistent fMP4 producer initialization on Windows by running FFmpeg in the producer output
  directory so its relative init segment is resolved consistently across platforms.
- Replaced per-segment HLS transcoding with one durable, fenced VOD producer per session. The
  assigned source worker now owns one playback-rate Jellyfin source pull, publishes completed
  segments to shared object storage, survives controller recovery through schema v9 state, and
  switches playback windows only for dominant seeks or quiet demand. Added explicit producer agent
  commands/capabilities, in-memory signed-in-user credential transfer, idle shutdown, drain/failover
  fencing, redacted producer APIs, and dashboard status. The UI and documentation now call out that
  this single-producer guarantee covers HLS VOD only; direct fragmented MP4 has since been removed.
  Producer and segment lease cleanup now fails safely during a temporary
  Valkey outage so workers survive coordination-backend restarts and reconnect normally.
- Added trusted-proxy regional edge selection with stable session affinity, viewer-region → session
  preferred-region → any-edge fallback, edge-scoped grants per manifest, runtime/UI/deployment
  settings for the region header and producer idle timeout, and spoofed-header fallback metrics.

- Reworked loading states across the dashboard with responsive, content-shaped skeletons for
  discovery media, sessions, live tables, people and access, settings forms, profiles, nodes,
  infrastructure, jobs, diagnostics, relay creation, and first-run setup. Loading layouts now hold
  the final page geometry and expose a single useful status announcement to assistive technology.
- Flattened the role-aware navigation into one shadcn sidebar that collapses to icons, with User
  and Admin groups and direct links to every destination. Removed the redundant Settings/System
  overview pages, secondary Settings rail, and legacy segmented infrastructure/settings switchers.
- Simplified sign-in to one Jellyfin form; entering the recovery-owner password with no username
  now provides the discreet local recovery path without exposing a separate login mode.
- Refined Jellyfin discovery artwork to sit flush with card edges, removed the season poster from
  the episode chooser, and expanded episode cards with landscape artwork, metadata, and summaries.
- Made the default standalone install fully in-process: its bundled worker registers and
  heartbeats without starting the cluster mTLS agent controller or provisioning cluster
  certificates. Cluster transport remains available to dedicated controller deployments.
- Refined the unified shell with the account menu at the top of the sidebar, the theme control in
  the header, grouped per-page Settings navigation, and a role-aware Sessions page for personal or
  system-wide relay links. Jellyfin users can now create and manage their own isolated OBS live
  channels and live playback sessions; operators retain the all-channel view.
- Unified Jellyfin users and administrators in one role-aware `/dashboard/*` experience. Jellyfin
  identities now receive explicit user, operator, admin, or owner grants; the local password is a
  recovery owner; browser sessions, CSRF handling, catalog, and session APIs are shared; and the
  separate portal routes and cookies were removed. Settings and System are now focused hubs for
  people, connections, profiles, networking, runtime, API access, infrastructure, work, and
  diagnostics. SQLite and PostgreSQL schema v8 persist identities and revisioned grants.
- Fixed standalone worker recovery and local relay placement. Resuming the local worker now updates
  it directly instead of attempting delivery through a nonexistent agent connection; local
  provider credentials are advertised as node capabilities; and the relay wizard validates Local
  placement before continuing instead of allowing a later error.
- Made dashboard-requested native restarts supervisor-safe on macOS and Windows, suppressed routine
  three-second liveness probes from request logs, and added bounded 10 MiB macOS service-log
  rotation with eight retained files.
- Fixed the macOS menu app's **Start Relay** and **Open Dashboard** recovery actions after a
  listener change. An unhealthy but already-loaded LaunchAgent is now restarted so pending runtime
  settings take effect instead of leaving the old listener running.
- Allowed native Network settings to bind the dashboard/API to a specific IPv4 or IPv6 interface
  instead of requiring loopback or a wildcard. The macOS menu app and Windows tray follow that
  saved local listener, and Windows native installs now enable writable runtime settings through a
  non-secret, user-readable configuration projection separate from protected service data.
- Fixed Network settings saves reporting that the runtime configuration could not be cloned after
  the server had already persisted it.
- Fixed the macOS menu app opening a blank dashboard on first launch or after a failed service
  start. **Open Dashboard** now installs or repairs the background service, waits for its health
  endpoint, and opens the browser only after the dashboard is ready.
- Fixed Safari rendering the loopback dashboard as a blank page after an HTTPS public/admin URL was
  saved. Same-origin assets no longer receive a redundant policy that upgrades the native app's
  local HTTP recovery URL to HTTPS.
- Fixed local administrator and portal logins after an HTTPS admin URL is advertised. Session and
  CSRF cookies now use the actual trusted request protocol, remaining secure behind HTTPS while
  working through the native app's loopback HTTP recovery URL.
- Migrated the web application to the SvelteKit 3 prerelease line and Cookie 2, moved framework
  configuration into Vite, adopted the native `#lib` alias, and refreshed the remaining stable
  Svelte, Tailwind, Lucide, and AWS SDK dependencies.
- Promoted the Luma administrator dashboard as the sole interface, removed the retired Nova route
  and component tree plus the interface switch, and removed the former `/new/*` preview namespace.
  `/dashboard/*` is now the only administrator route tree.
- Improved the dashboard Network settings with a guided Nginx Proxy Manager publishing flow:
  one-hostname URL defaults, precise trusted-proxy guidance, an NPM front-door checklist, and a
  Docker-network discovery command. The dashboard continues to leave DNS, certificates, router
  forwarding, and reverse-proxy administration outside the relay security boundary.
- Added the Luma user portal with per-user Jellyfin authentication, account-scoped catalog access,
  administrator-controlled default/allowed profiles, and simple shareable relay-link creation. The
  administrator Luma interface is available under `/dashboard/*`, while the base URL selects the
  portal or dashboard.
- Refined portal discovery to stay empty until a user searches, return only movies and shows, and
  open a show-specific season and episode chooser. Active relay links now stay above discovery, and
  movie, show, season, and episode artwork is fetched through an authenticated same-origin proxy.
- User Jellyfin passwords are now transient login inputs. Provider access tokens live in the secret
  backend for the browser session, and each created relay receives its own secret copy so logging
  out does not invalidate an existing playback link. User session listing and deletion are isolated
  by provider identity and all mutations remain CSRF-protected.
- Fixed dashboard and user-portal mutations in newly opened tabs by recovering each session's CSRF
  token from a same-site companion cookie.
- Fixed first-run portal access so adding the first delegated Jellyfin endpoint automatically enables
  the user portal with the default VOD profile. Settings also repairs existing single-endpoint setups
  that predate the automatic handoff.
- Added a complete shadcn-svelte Luma dashboard under `/dashboard/*`, including every
  administrator route, responsive Sidebar/Sheet navigation, table/card data views, the four-step
  relay workflow, and persistent system/light/dark themes.
- Replaced the macOS installer package with a drag-to-Applications DMG. The signed app now carries
  the sealed runtime and installs or upgrades a per-user LaunchAgent without administrator
  approval. The relay and menu app start automatically at login, and CI publishes a development
  DMG for every macOS run.
- Fixed per-user LaunchAgent rendering so installed runtime arguments replace the packaged
  placeholders instead of being inserted alongside them.
- Fixed the macOS menu controller to follow an exact configured LAN listener for health checks and
  dashboard opening. Ordinary LaunchAgent restarts now use launchd's in-place restart operation,
  avoiding unnecessary unload/bootstrap races.
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
- Expose copy and confirmed revocation as the current Sessions actions; link the
  advanced relay workflow with placement preview, preferred region or exact
  locked worker, and a completed-session handoff; persist navigation collapse;
  and provide skip navigation plus mobile focus/Escape behavior.
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
  implemented MPEG-TS and fMP4 HLS delivery shapes. Direct fragmented-MP4
  streaming was subsequently removed during audit remediation.
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
- Keep node-targeted cache inventory and eviction available through the
  authenticated cluster API while presenting the current dashboard's
  controller-local cache scope explicitly.
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
  indefinitely, evict successful paths after bounded inactivity, and coalesce
  concurrent viewer setup onto one edge path operation.
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
