# Phase 6 implementation checkpoint — signed edge playback grants

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
npm run format:check
npm run check
npm run lint
npm run build:packages
npm run build --workspace @vrrelay/relay
```

Result: all commands passed.

## Deferred to later Phase 6 and final high-pass verification

- Valkey-backed 30-second viewer aggregation by edge and exact byte-counter
  reconciliation.
- Node-targeted cache inventory, restore validation, eviction, disk-pressure
  handling, and object-store lifecycle reconciliation.
- Per-node backend activation acknowledgement.
- Live ingest-origin/region selection, immutable-profile-driven normalization,
  primary/backup publisher states, origin recovery, and one upstream pull per
  active edge evidence.
- Full `npm run ci` under the checksum-verified pinned Node runtime and
  destructive multi-process edge/live failure evidence.
