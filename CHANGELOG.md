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

### Security

- Keep provider credentials, node identities, playback grants, source URLs,
  backend secrets, certificates, and private media out of public contracts and
  repository fixtures.
- Preserve structured FFmpeg settings, shell-free process spawning, opaque
  internal source grants, URL policy checks, hashed enrollment/token records,
  and platform secret-store adapters as security foundations requiring broader
  Phase 3 and release-gate verification.

### Known limitations

- The audited repository has not yet passed the feature-complete public release
  candidate gate.
- Distributed state transitions, role isolation, migration behavior, media
  matrices, edge/live failure handling, dashboard workflows, observability,
  deployment topologies, native installers, and supply-chain outputs require
  the remaining reconciliation phases.
- Real VRChat PC compatibility, Quest compatibility, clean-machine native
  installation, hosted cloud adapters, and destructive Kubernetes/cluster
  recovery are not currently supported release claims.
