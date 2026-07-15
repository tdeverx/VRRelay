# Phase 7 implementation checkpoint — dashboard node cache workflow

Date: 2026-07-15

This is a build-first implementation checkpoint for one Phase 7 administrator
workflow. It is not final dashboard, browser, accessibility, realtime, or
release-candidate evidence.

## Scope completed

- The cluster dashboard cache panel now targets either the controller-local
  cache or a connected source-worker/edge node cache.
- The cache target selector only lists connected nodes whose roles own cache
  state. If a selected node disconnects or no longer has a cache-owning role,
  the dashboard falls back to the local cache instead of keeping a stale hidden
  target.
- Cache inventory refreshes use `GET /api/v1/cache` with `nodeId` only for
  remote node targets.
- Bulk eviction includes `nodeId` only for selected remote targets, preserving
  the standalone/local default and avoiding accidental local eviction when a
  remote target is intended.
- The panel copy now describes node cache rather than edge-only cache because
  source workers and edges can both own temporary cache objects.

## Lean guardrails run

Runtime used locally:

- Node: `v22.22.3`
- npm: `10.9.8`

The repository pin is Node `22.23.1`; the pinned-runtime full gate remains part
of the final high-pass verification bundle.

Commands:

```text
npm run check --workspace @vrrelay/web
npm run format:check
npm run check
npm run build --workspace @vrrelay/web
npm run ci
```

Result: all commands passed. Svelte diagnostics reported zero errors and zero
warnings. The full CI gate passed 356 tests with 23 intentional skips and
reported zero npm vulnerabilities.
