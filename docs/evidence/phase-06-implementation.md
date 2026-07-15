# Phase 6 implementation checkpoint — edge delivery, node cache control, and live normalization

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
- The cache administration API can target a connected node with `nodeId` for
  inventory and eviction. The controller routes those requests through strict
  `cache.inventory` and `cache.evict` agent envelopes, validates typed node
  responses, and fails closed instead of silently evicting the controller-local
  cache when the requested node is disconnected.
- Object-store restores now validate size and SHA-256 as before, but corrupt
  remote objects are invalidated and treated as a cache miss. Completed segment
  jobs can be re-leased when their cached output has been evicted or rejected,
  allowing the normal generation/origin path to refill the object instead of
  failing playback on stale job state.
- Published and restored disk-cache objects now retain local references to their
  object-store keys. Explicit cache eviction removes the local object and deletes
  the corresponding remote object-store entry, while ordinary disk-pressure
  cleanup still leaves the remote tier available for restore.
- Segment generation and object-store restore now enforce the configured disk
  cache limit immediately instead of waiting for the periodic cleanup loop. The
  segment just requested is protected while older cached objects are evicted to
  bring disk usage back under the configured limit where possible.
- Edge live playback forgets cached MediaMTX path configuration after a failed
  HLS upstream response, so the next viewer request reapplies the origin pull
  source instead of pinning a stale path configuration indefinitely.
- Normalized live channels now pin the first selected live-session profile on
  the channel document, reject later conflicting normalized-profile choices, and
  start FFmpeg normalization only with that immutable profile. The FFmpeg live
  normalizer now derives encoder, dimensions, frame rate, pixel format, bitrate,
  maxrate, buffer, GOP/keyframe interval, B-frames, audio codec, channels, sample
  rate, and audio bitrate from the selected profile instead of process-level
  defaults.
- Live publisher authorization now atomically claims a publisher slot before
  MediaMTX accepts a publish request. A second publisher is rejected while the
  channel is `online` or `reconnecting`, and primary/backup URLs can publish
  again only after reconciliation marks the channel offline.
- Administrators can issue replacement OBS publisher credentials for a live
  channel. Replacement tokens are staged server-side, old credentials are no
  longer accepted for reconnects once replacement is authorized, and the
  replacement token can claim the publisher slot even while the previous
  publisher is still marked `online` or `reconnecting`. The replacement hash is
  promoted to the primary publisher hash on successful MediaMTX authorization
  and is never returned in public channel responses.

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
npx vitest run packages/contracts/src/agent-protocol.test.ts apps/relay/src/agent-transport.test.ts apps/relay/src/server.test.ts apps/relay/src/composition/runtime.test.ts
npx vitest run packages/application/src/services.test.ts
npx vitest run packages/application/src/services.test.ts -t "corrupt object-store restores"
npx vitest run packages/application/src/services.test.ts -t "disk cache pressure"
npx vitest run apps/relay/src/composition/role-server.test.ts
npx vitest run apps/relay/src/composition/role-server.test.ts -t "reconfigures a live edge origin path"
npx vitest run packages/application/src/services.test.ts -t "live"
npx vitest run packages/application/src/services.test.ts -t "Live relay service"
npx vitest run packages/application/src/services.test.ts -t "administrator-issued publisher replacement"
npx vitest run packages/adapters/src/ffmpeg-live-normalizer.test.ts
npm run generate:api
npm run check:agent-protocol-schema
npm run check:api
npm run check:tests
npm run check --workspace @vrrelay/application
npm run check --workspace @vrrelay/adapters
npm run check --workspace @vrrelay/relay
npm run format:check -- --ignore-unknown
npm run format:check
npm run check
npm run lint
npm run build:packages
npm run build --workspace @vrrelay/relay
npm run ci
```

Result: all commands passed. The local full CI gate passed 360 tests with 23
intentional skips and reported zero npm vulnerabilities.

## Deferred to later Phase 6 and final high-pass verification

- Broader external object-store lifecycle and destructive outage evidence.
- Destructive origin recovery evidence and one upstream pull per active edge
  evidence.
- Full `npm run ci` under the checksum-verified pinned Node runtime and
  destructive multi-process edge/live failure evidence.
