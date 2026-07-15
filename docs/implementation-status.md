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

## Known gaps in the audited checkout

- Phase 1 restored a clean local engineering baseline: format, lint, workspace
  and test-source typechecks, generated-client freshness, unit tests, builds,
  and the npm dependency audit pass under the pinned Node runtime. This is a
  baseline gate, not evidence for the unreached feature and deployment phases.
- Runtime composition still mixes roles, persistence uses broad document
  updates and non-immutable migration behavior, and distributed cancellation,
  recovery, placement, and credential boundaries require further work.
- Node enrollment currently needs security redesign around local private-key
  generation, certificate rotation, durable drain, typed protocol messages,
  transport enforcement, and role-specific exposure.
- Several media-profile fields and experimental delivery modes are incomplete
  or schema-only. Hardware pipelines, subtitles, tone mapping, passthrough,
  fMP4 concurrency, dual PC/Quest outputs, and corrupt-input handling lack the
  required matrix evidence.
- Edge grants/revocation, viewer aggregation, targeted cache administration,
  backend activation, live backup/replacement behavior, origin recovery, and
  one-pull-per-edge guarantees are incomplete.
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
