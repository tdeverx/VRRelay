# Phase 8 implementation checkpoint — readiness and operations

Date: 2026-07-15

This is a build-first implementation checkpoint for Phase 8. It is not final
operations, destructive, benchmark, deployment, or release-candidate evidence.

## Scope completed

- `/api/v1/health` remains a lightweight unauthenticated liveness endpoint for
  process/version/worker-capacity checks.
- `/api/v1/ready` is now a separate unauthenticated dependency-readiness
  endpoint. It uses the backend health aggregate, reports HTTP 503 when any
  dependency is unhealthy or a staged backend change requires restart, and
  reports HTTP 200 only when the runtime is ready to serve traffic.
- Readiness responses expose dependency `category`, `kind`, `healthy`,
  `checkedAt`, and `restartRequired` only. Backend messages are intentionally
  omitted so private endpoints, filesystem paths, cloud resource names, and
  other operational details do not become public health output.
- The OpenAPI contract and generated dashboard client now include
  `getReadiness`.
- Prometheus egress and viewer metrics no longer use unbounded `session`
  labels. Egress is emitted as a total counter, `viewers_active` is emitted as
  an aggregate gauge during cleanup, and exact per-session viewer/egress state
  remains in repository state, events, and playback accounting rather than
  long-lived metric labels.
- Segment generation, queue pressure, worker utilization, segment job
  attempts/retries/failures/duration, disk/object cache requests, object-store
  operation latency/errors, and object restore outcomes are now emitted through
  bounded Prometheus labels such as `mode`, `outcome`, `operation`, `kind`,
  `delivery`, and `encoder`. Session IDs, object keys, URLs, and node IDs are
  intentionally excluded from these long-lived series.
- Live publisher state, publisher authentication/replacement, reconnect, and
  normalizer transition metrics now use bounded labels such as `state`,
  `credential`, `outcome`, and `reason`. Channel IDs, ingest paths, tokens, and
  URLs are intentionally excluded.
- Static routing can now be validated, activated, persisted, and reloaded
  alongside the built-in and webhook traffic directors. It can pin playback to
  an exact online edge or to a configured region without storing webhook
  endpoints or secrets, and pinned-node region mismatches fail closed.
- Agent logs now have explicit per-node retention and query caps controlled by
  `VRRELAY_AGENT_LOG_RETENTION_ROWS` and `VRRELAY_AGENT_LOG_QUERY_LIMIT`.
  Redacted node logs are persisted, exposed through bounded list responses, and
  emitted as `node.log` events on the authenticated operations stream.
- Segment jobs now write structured, secret-redacted lifecycle logs with
  explicit per-job retention and query caps controlled by
  `VRRELAY_JOB_LOG_RETENTION_ROWS` and `VRRELAY_JOB_LOG_QUERY_LIMIT`. Job logs
  are persisted, exposed through bounded list responses, visible in the cluster
  dashboard, and emitted as `job.log` events on the authenticated operations
  stream.
- `script/benchmark.mjs` now provides reproducible playlist, cached-egress,
  uncached-encode, live-fan-out, cache-ratio, and resource-snapshot scenarios.
  Each report includes sanitized target metadata plus CPU/RAM/GPU resource
  snapshots so later retained benchmark runs can be tied to their host and
  workload.

## Lean guardrails run

Runtime used locally:

- Node: `v22.22.3`
- npm: `10.9.8`

The repository pin is Node `22.23.1`; the pinned-runtime full gate remains part
of the final high-pass verification bundle.

Commands:

```text
npm run generate:api
npx vitest run apps/relay/src/server.test.ts -t "readiness"
npx vitest run apps/relay/src/backend-service.test.ts -t "static routing"
npx vitest run packages/application/src/cluster-service.test.ts -t "static edge"
npx vitest run packages/application/src/cluster-service.test.ts -t "agent log retention"
npx vitest run apps/relay/src/config.test.ts -t "agent log retention"
npx vitest run packages/application/src/services.test.ts -t "finite manifest"
npx vitest run packages/adapters/src/sqlite-repository.test.ts -t "job logs"
npx vitest run packages/adapters/src/sqlite-repository.test.ts -t "migration"
npx vitest run packages/adapters/src/postgres-repository.test.ts -t "migration"
npx vitest run packages/application/src/services.test.ts
npx vitest run script/benchmark.test.mjs
node script/benchmark.mjs --scenario resource-snapshot
npm run check:api
npm run check:agent-protocol-schema
npm run check --workspace @vrrelay/contracts
npm run check --workspace @vrrelay/relay
npm run check --workspace @vrrelay/application
npm run check --workspace @vrrelay/web
npm run ci
```

Result: all commands passed. The local full CI gate passed 372 tests with 23
intentional skips and reported zero npm vulnerabilities.

## Deferred to later Phase 8 and final high-pass verification

- Per-node egress metrics beyond the current aggregate viewer/egress, queue,
  job, cache, object, worker, ingest-state, publisher reconnect, and
  normalizer counters.
- Retained benchmark runs against target environments, using the scenario
  runner and metadata now checked in.
- Destructive operations evidence under real repository, coordination, object
  storage, MediaMTX, and agent-listener failures.
