# Phase 9 implementation checkpoint — automated verification expansion

Date: 2026-07-16

This is an automated-verification checkpoint. It is not the Phase 9 exit gate:
the repository suite is green, while the media matrix, destructive cluster
matrix, hosted adapters, and retained target-environment benchmarks remain
pending.

## Scope completed

- A reusable `MediaProvider` contract suite now runs against both an in-memory
  fake and a Jellyfin adapter backed by a local HTTP fixture. Fourteen contract
  cases cover capability metadata, user/API-key authentication, validation,
  search, pagination, hierarchy, media-version and track mapping, explicit
  source selection, full/ranged source streams, ordered playback lifecycle,
  cancellation, and rejected-secret redaction without requiring real provider
  credentials.
- Four HTTP-boundary security tests exercise remote first-run setup, hardened
  login cookies, browser CSRF, PAT scope/expiry/revocation, malformed JSON and
  secret-bearing schema failures, and valid/tampered/revoked/expired playback
  grants. Invalid JSON now returns a generic response instead of reflecting the
  parser's input, and the router accepts the bounded signed-grant path length
  needed by valid playback URLs.
- Playwright covers setup/login, desktop and mobile navigation behavior, scoped
  PAT creation/revocation, logout, browser page errors, and serious/critical Axe
  findings across desktop and mobile Chromium. A dedicated CI job retains trace,
  screenshot, and video artifacts on failure.
- Benchmark reports now have a schema version, private atomic output,
  request-error enforcement, target-comparability checks, a baseline SHA-256,
  and throughput/p95 regression gates with distinct setup-error and gate-failure
  exit codes. This makes retained benchmark output enforceable without claiming
  that one host's limits apply universally.
- A redacted repository-history scan and a second scan of the current tracked
  and nonignored candidate source found no detected secrets. This does not
  replace final artifact, container, dependency, or code-security scans.

## Focused verification

Runtime:

- Node: `v22.23.1`
- npm: `10.9.2`

Commands:

```text
npx vitest run packages/adapters/src/media-provider-contract.test.ts \
  apps/relay/src/server-security.test.ts script/benchmark.test.mjs
npx playwright test
```

Results:

- Provider, HTTP-security, and benchmark files: 26 of 26 tests passed.
- Browser suite: four of four desktop/mobile project cases passed with no
  captured page errors or serious/critical Axe findings.
- Existing relay server coverage was also rerun separately: 36 of 36 tests
  passed.
- The complete pinned Node `22.23.1` `npm run ci` gate passed 395 tests with 23
  intentional skips across 40 passing test files and one skipped opt-in file.
  Formatting, generated-client freshness, workspace and test-source typechecks,
  Svelte diagnostics, lint, production builds, repository guards, and the npm
  audit all passed; the audit reported zero vulnerabilities.
- A fresh detached local checkout then repeated `npm ci`, `npm run ci`, and
  `npm run test:browser` successfully. The root check now builds the
  provider-neutral workspace packages before validating the generated agent
  protocol schema, so this gate no longer depends on stale local `dist` output.

## Deferred to the Phase 9 exit gate

- Real MinIO/S3-compatible, Azure Blob, GCS, PostgreSQL, Valkey, platform secret
  store, traffic-webhook, metrics-webhook, and opt-in real Jellyfin contract
  evidence where applicable.
- MPEG-TS/fMP4, subtitles, tone mapping, passthrough, hardware pipelines,
  truncated input, and multi-seek media integration coverage.
- Process kills, network partitions, database/Valkey/object-store outages,
  partial uploads, disk exhaustion, certificate expiry, worker/origin loss,
  cancellation, publisher replacement, and rolling-upgrade cluster scenarios.
- Complete browser coverage for every administrator workflow, plus retained
  logs, manifests, metrics, checksums, and target-environment benchmark reports.
- Docker-backed and multi-host destructive work could not be promoted by these
  local tests; it remains an external execution gate.
