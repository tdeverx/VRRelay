# Phase 6 implementation checkpoint — edge grants and viewer aggregation

Date: 2026-07-15

This is a build-first implementation checkpoint for Phase 6. It is not final
edge-failure, live-fan-out, destructive cluster, deployment, or release-candidate
evidence.

## Scope completed

- Controller-generated VOD playlists now exchange the administrator-facing
  playback token for a signed edge playback grant before placing edge segment
  URLs in the playlist.
- Controller-generated live redirect playlists now use a signed edge playback
  grant for the selected edge URL.
- Edge grants are scoped to one session and one edge node. Edge-only runtimes
  reject a grant minted for a different node.
- Edge grant validation checks the underlying durable playback grant on every
  request. Session deletion or playback-grant revocation therefore invalidates
  already minted edge links.
- The original controller playback URL remains the URL an administrator
  distributes; selected edge URLs are an internal playlist-routing detail.
- Viewer identity aggregation now prefers the coordination backend. Local mode
  uses in-memory rolling maps, and Valkey mode uses sorted sets to retain
  30-second salted fingerprints by edge and by session total.
- Egress bytes remain exact counters separate from viewer estimation; viewer
  counts update the session total and expose per-edge active-viewer gauges.
- Object-store backend application is now acknowledged per node. A restarted
  node records `backend.object-store.applied.<nodeId>`, and backend health no
  longer treats one node's restart as cluster-wide application of a staged
  object-store change.
- Live channel creation now records the selected ingest origin and region when
  online ingest-origin nodes are present. Preferred-region requests choose a
  matching origin; standalone/local creation keeps working without cluster
  origin state.

## Lean guardrails run

Runtime used locally:

- Node: `v22.22.3`
- npm: `10.9.8`

The repository pin is Node `22.23.1`; the pinned-runtime full gate remains part
of the final high-pass verification bundle.

Commands:

```text
npx vitest run packages/application/src/services.test.ts -t "edge-scoped playback grants"
npx vitest run apps/relay/src/server.test.ts -t "signed edge grants"
npx vitest run packages/adapters/src/local-infrastructure.test.ts -t "viewer fingerprints"
npx vitest run apps/relay/src/backend-service.test.ts -t "object store"
npx vitest run packages/application/src/services.test.ts -t "selected ingest origin"
npm run format:check
npm run check
npm run lint
npm run build:packages
npm run build --workspace @vrrelay/relay
```

Result: all commands passed.

## Deferred to later Phase 6 and final high-pass verification

- Node-targeted cache inventory, restore validation, eviction, disk-pressure
  handling, and object-store lifecycle reconciliation.
- Immutable-profile-driven normalization, primary/backup publisher states,
  origin recovery, and one upstream pull per active edge evidence.
- Full `npm run ci` under the checksum-verified pinned Node runtime and
  destructive multi-process edge/live failure evidence.
