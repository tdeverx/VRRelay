# Testing guide

## Fast local feedback

```sh
npm run check
npm test -- --run
```

`npm run check` runs TypeScript and Svelte diagnostics across every workspace. Unit tests use temporary directories and generated media; they must not depend on a developer's library or credentials.

Timing-sensitive tests should wait for observable state or use an explicit gate/fake clock instead
of sleeping for a presumed scheduler interval. Local Vitest tests retain a 15-second test/hook
budget; CI allows 30 seconds for loaded cross-platform runners. Playwright uses a 30-second local
test budget and 45 seconds in CI, with 5-second and 10-second assertion budgets respectively.
Per-test extensions are reserved for workflows that are intentionally longer, not for masking an
unbounded wait.

## Full repository gate

```sh
npm run ci
```

This checks formatting, lint, types, unit tests, the production build, and the npm vulnerability threshold. API changes also require:

```sh
npm run generate:api
git diff --exit-code -- apps/web/src/lib/generated/vrrelay-api
```

Generated client files are committed so consumers and reviewers see contract changes directly.

## Pull-request validation

GitHub runs one check for each release risk. The commands are direct and can be
run locally when their platform prerequisites are available:

```sh
npm run ci
npm run test:browser
npm run test:cluster
npm run validate:deployment
npm run validate:macos-package
npm run validate:windows-build
```

The pull-request and merge-queue checks cover core source behavior, the
administrator browser journey, the complete cluster, deployment configuration,
and each release platform. They do not repeat one another. A protected `main`
merge builds and publishes the rolling release without rerunning the PR suite.
Real Jellyfin and live-service tests remain explicit environment-backed
evidence rather than default checks.

Agent-protocol changes also require the strict contract tests and reproducible
schema freshness gate:

```sh
npx vitest run packages/contracts/src/agent-protocol.test.ts
npm run check:agent-protocol-schema
```

The complete node-transport suite opens a loopback mTLS WSS listener and therefore
requires an environment that permits local socket binding:

```sh
npx vitest run apps/relay/src/agent-transport.test.ts
```

It covers enrollment retry, certificate proof/rotation/expiry/revocation, replay
and payload abuse, request cleanup, durable drain/restart behavior, and both DNS
name and IP-address TLS identities.

## Cluster acceptance

The release-level harness builds the production container and provisions a disposable cluster with
one controller, two source workers, one ingest origin, two edges, PostgreSQL, Valkey, MinIO, a
deterministic Jellyfin-compatible fixture, MediaMTX, and an OBS-compatible FFmpeg publisher.

```sh
npm run test:cluster
```

It verifies node enrollment over mTLS WSS, node-local primary and failover provider credentials,
finite VOD manifests, one cluster-wide job for identical edge requests, byte-identical MPEG-TS edge
output, completed per-worker attempt history, edge draining, worker revocation and failover,
controller restart recovery, and one live
origin path per active edge. The harness owns the `vrrelay-acceptance` Compose project and removes
its containers and volumes on completion. Use `node script/integration-harness.mjs --keep` to retain
the cluster for diagnosis, or `--skip-build` to reuse an existing `vrrelay:harness` image.

This test downloads and builds multiple container images. Budget at least 8 GB of free Docker and
host storage before running it.

When MinIO and MediaMTX images are unavailable, the smaller real-process VOD harness still exercises
the built relay against PostgreSQL and Redis with two workers and two edges:

```sh
npm run test:local-cluster
```

It builds the application, starts project-scoped disposable database containers, runs the relay
roles as separate host processes, and verifies real FFmpeg output, mTLS enrollment, cluster-wide
coalescing, completed per-worker attempt history, node-local failover bindings, administrative certificate rotation, edge drain, worker
revocation, PostgreSQL and Redis restart tolerance, controller restart, and playback-grant recovery.
It uses ports `19096`, `19100`, `19110`, `19201`, `19202`, `19211`, `19212`, `19379`, and `19432`.

Hosted Linux and Windows checks install checksum-pinned FFmpeg 8.1.2 runtimes
from `deploy/runtime-manifest.json`; hosted macOS checks build the pinned source
recipe before running the same repository gate. Local runs use the compatible
FFmpeg on `PATH`. CI never falls back silently to a distribution package.

## Integration boundaries

Real-service tests are opt-in and read secrets only from ignored environment values. The Jellyfin command is documented in `CONTRIBUTING.md`. Hosted Azure Blob and GCS contract tests, extended destructive cluster recovery, native installers, and real VRChat clients require their target environments and remain release evidence rather than default unit tests.

For a complete standalone Jellyfin smoke test—authentication, catalog, finite manifest, real-time
FFmpeg segment generation, playback revocation, and credential deletion—run:

```sh
VRRELAY_TEST_JELLYFIN_URL=https://jellyfin.example \
VRRELAY_TEST_JELLYFIN_USER=your-test-user \
VRRELAY_TEST_JELLYFIN_PASSWORD='...' \
npm run test:real-jellyfin
```

The password is forwarded only in the authenticated provider-creation request and is not inherited
by the relay child process or written to test logs. Add `-- --keep` only when retaining ignored
diagnostic state after a failure is necessary.

For a real OBS-compatible live smoke test, provide the pinned MediaMTX executable and its extracted
configuration alongside FFmpeg:

```sh
VRRELAY_TEST_MEDIAMTX=/path/to/mediamtx \
VRRELAY_TEST_MEDIAMTX_CONFIG=/path/to/mediamtx.yml \
VRRELAY_TEST_FFMPEG=ffmpeg \
npm run test:real-live
```

Add `-- --managed-mediamtx` to exercise the native-package topology, where the relay service starts, monitors, and shuts down the bundled MediaMTX process itself. This mode requires the MediaMTX configuration path.

This publishes generated H.264/AAC over the one-time authenticated RTMP URL, exercises the default
real-time normalizer, retrieves an MPEG-TS segment through the opaque grant-backed relay URL,
reconciles publisher disconnect, revokes playback, and deletes the live channel. Pass
`-- --passthrough` only to test the non-normalizing diagnostic path.

When testing media behavior, record the source properties, profile name and update time, platform, player, startup, duration, pause, seeks, late join, completion, audio/video, and HTTPS/URL-permission result. Do not infer VRChat compatibility from FFmpeg success alone.

## Benchmark scenarios

The benchmark runner emits scenario-scoped JSON with sanitized target metadata,
CPU/RAM/GPU snapshots before and after the run, request throughput, transfer
rate, status counts, failures, and latency percentiles. Results describe the
exact environment under test only; they are not universal viewer-limit claims.

```sh
npm run benchmark -- --scenario playlist --url https://relay.example/play/DISPOSABLE_GRANT/index.m3u8
npm run benchmark -- --scenario cached-egress --url https://relay.example/play/DISPOSABLE_GRANT/segment0.ts
npm run benchmark -- --scenario uncached-encode --url-template 'https://relay.example/play/DISPOSABLE_GRANT/segment-{i}.ts'
npm run benchmark -- --scenario live-fan-out --url https://relay.example/play/DISPOSABLE_GRANT/live.m3u8
npm run benchmark -- --scenario cache-ratio --url https://relay.example/play/DISPOSABLE_GRANT/hot.ts --url-template 'https://relay.example/play/DISPOSABLE_GRANT/cold-{i}.ts' --hot-ratio 0.8
npm run benchmark -- --scenario resource-snapshot
```

Exploratory runs still print the versioned JSON report to standard output. For
release evidence, retain it directly and make request failures authoritative:

```sh
npm run benchmark -- --scenario playlist \
  --url https://relay.example/play/DISPOSABLE_GRANT/index.m3u8 \
  --fail-on-errors \
  --output tmp/benchmarks/playlist-baseline.json
```

To enforce a target-specific baseline, repeat the same scenario, request count,
concurrency, timeout, and cache-ratio configuration, then opt into the regression
gate:

```sh
npm run benchmark -- --scenario playlist \
  --url https://relay.example/play/DISPOSABLE_GRANT/index.m3u8 \
  --fail-on-errors \
  --fail-on-regression \
  --baseline tmp/benchmarks/playlist-baseline.json \
  --max-regression-percent 10 \
  --output tmp/benchmarks/playlist-candidate.json
```

The regression gate checks both requests per second and p95 latency, records the
baseline report's SHA-256 digest in the candidate report, and exits with status 2
when an enforced check fails. Invalid arguments, unreadable/incompatible
baselines, and benchmark setup errors exit with status 1. Output reports are
written through a same-directory temporary file with private file permissions;
use a unique filename for every retained run.

Use real retained benchmark evidence only from disposable grants and test media
created for the target environment. Do not paste private relay URLs, playback
tokens, provider URLs, or customer media names into issues, logs, screenshots,
or documentation. The runner redacts common token-bearing URL shapes in its
metadata, but operators are still responsible for keeping raw command history
and terminal captures private.

## Deployment validation

Use the checks that match the changed area:

```sh
npm run check:compose
npm run test:container
npm run test:compose
helm lint deploy/kubernetes
helm template vrrelay deploy/kubernetes > /dev/null
swift build --package-path apps/macos -c release --arch arm64
script/verify-macos-dmg.sh dist/VRRelay-<build-id>-macOS-arm64.dmg <version> <build-number>
```

The container smoke test performs a fresh native-architecture image build, validates the pinned Node and FFmpeg versions and required media capabilities, proves the runtime user is non-root, then boots the relay with a read-only root filesystem and empty tmpfs-backed data/cache directories. It requires a healthy Docker daemon and removes its temporary image and container on exit. CI separately builds both amd64 and arm64 images through Buildx after this runnable native test passes.

The standalone Compose smoke test builds the production image, creates disposable data and cache volumes, waits for the relay health check, verifies the dashboard and MediaMTX Control API, confirms the MPEG-TS HLS setting and opens the RTMP listener. It removes its project-scoped containers, volumes, network, and image on exit.

The distributed acceptance harness is the single production-cluster topology test. The narrower
cluster Compose smoke was removed because it repeated the same enrollment, mTLS, role, and health
paths without exercising the harness's stronger media and failover assertions.

Windows packaging must be built and exercised on Windows. macOS signing and notarization require release-only credentials; ordinary local builds remain unsigned.
