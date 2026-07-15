# VRRelay

VRRelay is a GPLv3 self-hosted media relay that turns Jellyfin video-on-demand
and OBS live ingest into clean playback URLs for VRChat video players.

The project is intentionally split into provider-neutral application code and
external adapters. Jellyfin is the first media provider; FFmpeg performs
real-time transcoding; MediaMTX handles RTMP, SRT, and WHIP live ingest.

## Development status

This repository contains a substantial prerelease foundation for private-production v1:

- Node 22 TypeScript relay API and embedded dashboard host
- Jellyfin user-token and API-key authentication
- finite, seekable, just-in-time HLS VOD happy paths
- OBS live channel provisioning through MediaMTX
- controller, source-worker, ingest-origin, and edge scaffolding
- distributed segment caching with filesystem and cloud object-store adapters
- SQLite/PostgreSQL persistence and memory/Valkey coordination adapters
- SvelteKit operator dashboard
- SwiftUI macOS and Electron Windows service controllers
- standalone, Docker Compose, Helm, and native packaging foundations

The audited checkout is not yet a feature-complete release candidate. Several
runtime, distributed-state, deployment, dashboard, packaging, and verification
paths remain incomplete or unproven. Treat deployment files and automated
harnesses as development assets, not production evidence, until their phase
gates are linked from the [completion ledger](docs/v1-completion-ledger.md).
Current limitations and externally gated claims are listed in
[implementation status](docs/implementation-status.md).

No Jellyfin password or token belongs in the repository. Copy `.env.example`
to `.env` for local-only configuration.

## Quick start

```bash
npm ci
cp .env.example .env
make dev
```

The API defaults to `http://127.0.0.1:8099`; the web development server uses
`http://127.0.0.1:5173` and proxies `/api` and `/play` to the relay service.

The repository includes opt-in distributed harnesses for development. They are
not a substitute for the unreached destructive, target-platform, security, and
real-client release gates. See [the testing guide](docs/testing.md) for their
requirements and current scope.

See [the architecture overview](docs/architecture/overview.md),
[implementation status](docs/implementation-status.md), and
[security model](docs/architecture/security.md) before exposing a relay outside
a trusted network.

Contributor setup, repository boundaries, and validation commands are in
[CONTRIBUTING.md](CONTRIBUTING.md). The [code map](docs/architecture/code-map.md)
is the quickest route into the implementation. Maintainers should use the
[public release checklist](docs/public-release-checklist.md) before publishing a
versioned release.

## License

VRRelay is licensed under the GNU General Public License, version 3 or later.
See `LICENSE`.
