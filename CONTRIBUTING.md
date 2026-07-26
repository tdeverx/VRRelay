# Contributing to VRRelay

Thank you for helping build VRRelay. The project welcomes bug fixes, documentation, tests, compatibility evidence, provider adapters, deployment improvements, and carefully scoped features.

## Before you start

- Read the [architecture overview](docs/architecture/overview.md), [security model](docs/architecture/security.md), and [implementation status](docs/implementation-status.md).
- Search existing issues and pull requests before starting overlapping work.
- Open a design discussion before changing public contracts, security boundaries, media timelines, storage keys, or cluster protocol behavior.
- Never include real provider credentials, playback grants, certificates, private URLs, or media files in an issue, fixture, log, or commit.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development environment

Required tools:

- Node.js 26.5.0 and npm 12.0.1. The exact Node version is in `.nvmrc`.
- FFmpeg 8.1.2 with `libx264`, AAC, HLS, and MPEG-TS support.
- Git.

Optional tools depend on the area being changed:

- MediaMTX 1.19.2 for OBS/live work.
- Docker with Compose for deployment and distributed integration work.
- Swift 6.3 and macOS 15 for the menu controller.
- Windows x64, PowerShell, MSVC x64 Build Tools, Inno Setup 6, and WinSW for Windows packaging.
- Helm 4.2.3 for Kubernetes chart work.
- OpenTofu 1.10.6 for generic infrastructure-module work.

TypeScript 7 remains the project compiler, while the `typescript-compat` alias intentionally uses
Microsoft's `@typescript/typescript6` package for tools that require the compiler API. The direct
Cookie 0.7.2 declaration anchors SvelteKit's patched, API-compatible release; Fastify retains its
nested Cookie 2 dependency. The UUID 14 override is limited to the vulnerable UUID 9 dependency
paths in `gaxios` and `teeny-request`; UUID is not a direct project dependency. Dependency analyzers
may report these configuration anchors as unused even though removing them breaks linting, Svelte
checks, generation, builds, or the clean security audit.

Set up a clean checkout with:

```sh
npm ci
cp .env.example .env
npm run ci
```

`npm run dev` starts the relay and Svelte development server. The dashboard is at `http://127.0.0.1:5173`; API and playback requests proxy to port 8099.

## Repository map

| Path                         | Responsibility                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/domain`            | Provider-neutral models and validation rules. No infrastructure imports.                   |
| `packages/application`       | Use cases and ports. No Jellyfin, FFmpeg, database, HTTP, or platform DTOs.                |
| `packages/adapters`          | Jellyfin, FFmpeg, storage, database, coordination, metrics, and secret implementations.    |
| `packages/contracts`         | Shared request/event schemas.                                                              |
| `apps/relay`                 | HTTP service, authentication, agent transport, orchestration, and embedded dashboard host. |
| `apps/web`                   | SvelteKit administrative dashboard.                                                        |
| `apps/macos`, `apps/windows` | Thin service controllers; no media business logic.                                         |
| `contracts/openapi`          | Versioned public REST contract and generated dashboard client source.                      |
| `deploy`                     | Runtime manifest, native packaging, Compose, Helm, and generic infrastructure examples.    |

More detail is available in [docs/architecture/code-map.md](docs/architecture/code-map.md).
Testing boundaries and the API update workflow are described in
[docs/testing.md](docs/testing.md) and [docs/api.md](docs/api.md).

## Architecture rules

1. Domain and application packages stay provider and infrastructure neutral.
2. Provider credentials remain in a platform secret store on explicitly bound source workers.
3. Public APIs never expose secrets, source URLs, FFmpeg arguments, cloud SDK objects, or filesystem paths.
4. User input selects validated structured profile fields; it never becomes a shell fragment.
5. VOD manifests remain finite and seekable. VRChat/world logic owns viewer synchronization.
6. Segment object keys are deterministic. Writes are atomic and partial objects never become visible.
7. Experimental codecs and delivery methods are not promoted without recorded VRChat evidence.
8. Standalone SQLite/filesystem mode must keep working when cluster features change.

## Making a change

- Keep a pull request focused and explain the user-visible outcome.
- Add or update tests for behavior changes.
- Update OpenAPI, shared contracts, dashboard code, and documentation together when an API changes.
- Add a versioned database migration for persisted schema changes. Never mutate an old migration after release.
- Add compatibility evidence rather than changing a profile state based on assumptions.
- Preserve existing copyright and SPDX headers. shadcn-svelte generated components are tracked as generated upstream-derived UI primitives.

Generate the dashboard API client after changing OpenAPI:

```sh
npm run generate:api
git diff --exit-code -- apps/web/src/lib/generated/vrrelay-api
```

Do not hand-edit generated files.

## Tests and checks

Run the full local gate before opening a pull request:

```sh
npm run ci
```

Useful narrower commands:

```sh
npm test -- --run
npm run check
npm run lint
npm run format
docker compose -f deploy/docker/docker-compose.yml config
npm run check:compose
npm run test:container
helm lint deploy/kubernetes
tofu fmt -check -recursive deploy/opentofu
swift build --package-path apps/macos -c release --arch arm64
deploy/macos/package.sh release dmg
script/verify-macos-dmg.sh dist/VRRelay-<build-id>-macOS-arm64.dmg <version> <build-number>
```

The real Jellyfin contract test is opt-in:

```sh
VRRELAY_TEST_JELLYFIN_URL=https://jellyfin.example.test \
VRRELAY_TEST_JELLYFIN_USER=temporary-relay-user \
VRRELAY_TEST_JELLYFIN_PASSWORD='temporary-password' \
npx vitest run packages/adapters/src/jellyfin-provider.integration.test.ts
```

Use a temporary least-privilege user. Environment values must not enter snapshots or logs.

## Pull requests

A ready pull request includes:

- A clear problem statement and solution summary.
- Tests and the commands used to run them.
- Screenshots for dashboard changes and compatibility records for media changes.
- Security, migration, deployment, and rollback notes when applicable.
- Documentation and changelog updates for user-visible behavior.

Maintainers may ask to split a change when independent concerns would be easier to review separately.
