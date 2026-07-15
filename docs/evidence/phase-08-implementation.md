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
npm run check:api
npm run check --workspace @vrrelay/relay
npm run ci
```

Result: all commands passed. The local full CI gate passed 363 tests with 23
intentional skips and reported zero npm vulnerabilities.

## Deferred to later Phase 8 and final high-pass verification

- Low-cardinality queue, cache, object-latency, ingest, reconnect, node-egress,
  and session-bandwidth metrics.
- Bounded structured node/job log streaming and retention controls.
- Static routing adapter, benchmark scenarios, and retained benchmark metadata.
- Destructive operations evidence under real repository, coordination, object
  storage, MediaMTX, and agent-listener failures.
