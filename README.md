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

The major private-production v1 implementation and repository reconciliation
pass is complete. A fresh pinned-runtime checkout passes formatting, generated
contract checks, type checks, lint, 395 automated tests with 23 intentional
skips, production builds, the dependency audit, and the desktop/mobile browser
smoke suite.

That engineering checkpoint is not a release claim. Remaining product work
includes the full catalog, live/binding/failover, dependency-management,
certificate, metrics, realtime, and exhaustive accessibility workflows.
Release qualification also requires real multi-host and hosted-service failure
testing, signed native artifacts, clean-machine lifecycle tests, supply-chain
evidence, and real VRChat PC/Quest compatibility runs. The
[completion ledger](docs/v1-completion-ledger.md) and
[implementation status](docs/implementation-status.md) are the authoritative
records.

## Included today

- Node 22 TypeScript relay API with an embedded SvelteKit operator dashboard.
- Jellyfin authentication, catalog/source mapping, and playback activity.
- Finite, seekable, just-in-time HLS VOD with structured FFmpeg profiles.
- MediaMTX-backed OBS live ingest and live HLS fan-out.
- Standalone and role-separated controller, source-worker, ingest-origin, and
  edge runtimes with outbound mTLS agents.
- SQLite/PostgreSQL persistence, memory/Valkey coordination, and local,
  S3-compatible, Azure Blob, and Google Cloud Storage adapters.
- Docker Compose, Helm, provider-neutral OpenTofu, backup/restore, macOS, and
  Windows packaging pipelines with release guardrails.

H.264 8-bit `yuv420p`, AAC-LC stereo, MPEG-TS HLS, and HTTPS remain the intended
production defaults. Experimental formats are not compatibility claims.

## Requirements

- Node.js `22.23.1` and npm `10.9.2` (`.nvmrc` pins the Node version).
- FFmpeg 7.x with `libx264`, AAC, HLS, and MPEG-TS support.
- Git.

MediaMTX 1.18.2, Docker, Swift, Windows packaging tools, and Helm are needed
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
Jellyfin provider through the dashboard. The relay API listens on
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
