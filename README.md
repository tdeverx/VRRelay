# VRRelay

[![CI](https://github.com/tdeverx/VRRelay/actions/workflows/ci.yml/badge.svg)](https://github.com/tdeverx/VRRelay/actions/workflows/ci.yml)

VRRelay is a GPLv3 self-hosted media relay that turns Jellyfin video-on-demand
and OBS live ingest into clean playback URLs for VRChat video players.

The project keeps provider-neutral application code separate from external
adapters. Jellyfin is the first media provider, FFmpeg performs real-time media
processing, and MediaMTX handles RTMP, SRT, and WHIP live ingest.

> [!IMPORTANT]
> VRRelay is prerelease software for private, self-hosted evaluation. It is not
> yet a supported VRCDN replacement or a feature-complete public release
> candidate.

## Project status

The merged Build 100 private-production checkpoint passed the pinned-runtime
repository gate on Ubuntu, Windows, and macOS, both browser projects, the
distributed acceptance harness, the production container build, Helm,
OpenTofu, and security/audit checks.

That engineering checkpoint is not a release claim. Remaining product work
includes broader live/binding/failover, dependency-management,
certificate, metrics, realtime, and exhaustive accessibility workflows.
Release qualification also requires real multi-host and hosted-service failure
testing, signed native artifacts, clean-machine lifecycle tests, supply-chain
evidence, and real VRChat PC/Quest compatibility runs. The
[completion ledger](docs/v1-completion-ledger.md) and
[implementation status](docs/implementation-status.md) are the authoritative
records.

## Included today

- Node 26 TypeScript relay API with an embedded SvelteKit operator dashboard.
- Jellyfin authentication, movie/show filtering, series/season/episode browsing,
  source mapping, and playback activity.
- Finite, seekable HLS VOD with one durable, fenced producer per session and
  structured FFmpeg profiles.
- Configurable expiry for inactive unpinned playback links, session pinning,
  explicit user deletion, and guarded stale-user cleanup.
- MediaMTX-backed OBS live ingest and live HLS fan-out.
- Standalone and role-separated controller, source-worker, ingest-origin, and
  region-aware edge runtimes with outbound mTLS agents.
- SQLite/PostgreSQL persistence, memory/Valkey coordination, and local,
  S3-compatible, Azure Blob, and Google Cloud Storage adapters.
- Docker Compose, Helm, provider-neutral OpenTofu, backup/restore, a native
  macOS DMG, and a Windows installer pipeline with release guardrails.
- A GitHub-built rolling release pipeline with one moving `latest` tag and
  append-only, build-numbered historical assets.

H.264 8-bit `yuv420p`, AAC-LC stereo, MPEG-TS HLS, and HTTPS remain the intended
production defaults. Experimental formats are not compatibility claims.

## Distributed VOD behavior

Regional routing changes only the delivery edge. The first uncached request for
a VOD session starts one continuous producer on its assigned source-worker;
every edge restores the resulting deterministic segments from shared object
storage. Viewers in London, New York, and Sydney can therefore use nearby edges
without opening duplicate Jellyfin producers for the same session. A separate
session may start its own producer and consume another Jellyfin source stream.

Recent privacy-preserving viewer demand controls the shared playback window. A
dominant distant seek creates one fenced replacement generation, while adjacent
requests join the current producer. Idle producers stop after 60 seconds by
default and can resume from cached segments. Trusted proxies may supply the
configured viewer-region header; direct or malformed client values are ignored.
See the [architecture overview](docs/architecture/overview.md) and
[deployment guide](docs/deployment.md) for placement, failover, and rollout
requirements.

> [!NOTE]
> The one-producer guarantee currently covers HLS VOD, including MPEG-TS and
> fMP4-segmented HLS. Direct fragmented-MP4 streaming is not exposed: all VOD
> playback uses the admitted, fenced HLS producer path.

## Requirements

- Node.js `26.5.0` and npm `12.0.1` (`.nvmrc` pins the Node version).
- Native Linux npm installs require glibc 2.34 or newer for the bundled
  `better-sqlite3` 13 runtime. The Docker and Compose images use compatible
  Debian trixie bases.
- FFmpeg 8.1.2 with `libx264`, AAC, HLS, and MPEG-TS support.
- Git.

MediaMTX 1.19.2, Docker, Swift 6.3, MSVC Windows packaging tools, and Helm are needed
only for the corresponding live, deployment, or native workflows. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the complete tool matrix.

## Local quick start

```sh
nvm install
nvm use
npm ci
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173`, complete first-run administrator setup, and add a
Jellyfin provider through the dashboard. When creating a relay, choose Movies
or Shows; show selection continues through a season and episode before track
selection. The relay API listens on
`http://127.0.0.1:8099`; the development server proxies `/api` and `/play` to
that process. Keep credentials in the dashboard or an external secret backend,
never in the repository.

The distributed and real-service harnesses are opt-in. They are useful
engineering checks, but do not replace the retained release evidence described
in the [testing guide](docs/testing.md).

## Deployment paths

- Use the quick start above for local standalone development.
- Read [deployment](docs/deployment.md) and [operations](docs/operations.md)
  before evaluating standalone, Compose, Kubernetes, or multi-host modes.
- Treat native packages and OCI images as unreleased build outputs until the
  [public release checklist](docs/public-release-checklist.md) is complete.

## Documentation

| Guide                                                  | Purpose                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| [Architecture overview](docs/architecture/overview.md) | Runtime roles, persistence, media paths, and provider boundaries      |
| [Security model](docs/architecture/security.md)        | Trust boundaries, credentials, grants, transport, and threat controls |
| [Code map](docs/architecture/code-map.md)              | Fast route from a feature or boundary to its implementation           |
| [API workflow](docs/api.md)                            | OpenAPI and generated-dashboard-client ownership                      |
| [Compatibility](docs/compatibility.md)                 | Supported defaults versus experimental media behavior                 |
| [Testing](docs/testing.md)                             | Local, browser, integration, and real-service test scopes             |
| [Deployment](docs/deployment.md)                       | Standalone, Compose, Kubernetes, cloud-init, and native paths         |
| [Operations](docs/operations.md)                       | Health, readiness, metrics, logs, backup, and recovery                |
| [Releasing](docs/releasing.md)                         | Versioning, signing, notarization, provenance, and publication        |

## Security and support

Never publish Jellyfin credentials, playback or join tokens, certificates,
private endpoints, media, or unredacted logs. Report vulnerabilities using the
private process in [SECURITY.md](SECURITY.md); use [SUPPORT.md](SUPPORT.md) for
non-sensitive help.

## Contributing

Repository boundaries, development setup, validation commands, and pull-request
expectations are in [CONTRIBUTING.md](CONTRIBUTING.md). Participation is governed
by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

VRRelay is licensed under the
[GNU General Public License, version 3 or later](LICENSE).
