# Code map

This map describes where behavior belongs and how a request moves through VRRelay. It is intended for contributors who need to find the right boundary before editing.

## Dependency direction

```text
apps/relay ───────┐
apps/web          │
node agents       ├──> packages/application ──> packages/domain
                  │             │
packages/adapters ┘             └──> packages/contracts
        │
        └── external systems (Jellyfin, FFmpeg, databases, storage, MediaMTX)
```

`packages/domain` has no project-package dependencies. `packages/application` defines use cases and external ports without importing adapter implementations. `packages/adapters` implements those ports. `apps/relay` is the composition root and HTTP/agent boundary.

## Runtime entry points

| Concern                      | Start here                                      | Notes                                                                                                                                  |
| ---------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Process entry                | `apps/relay/src/main.ts`                        | Loads configuration and dispatches to the selected composition root.                                                                   |
| Role selection               | `apps/relay/src/composition/role-plan.ts`       | Accepts one dedicated role or all four roles for standalone.                                                                           |
| Composition roots            | `apps/relay/src/composition/roots.ts`           | Dispatches controller, source-worker, ingest-origin, edge, and standalone to distinct runtime factories.                               |
| Runtime ownership            | `apps/relay/src/composition/runtime.ts`         | Separate executable composition roots construct only the services and infrastructure owned by each role.                               |
| Runtime construction         | `apps/relay/src/composition/runtime.ts`         | Builds the role-specific object graphs, background work, and ordered shutdown sequences.                                               |
| Controller HTTP/API          | `apps/relay/src/server.ts`                      | Authentication, administrative API, public playback URLs, node enrollment/control, and embedded dashboard.                             |
| Data-plane HTTP              | `apps/relay/src/composition/role-server.ts`     | Exposes only source-worker, ingest-origin, or edge routes owned by the selected role.                                                  |
| Repository startup           | `apps/relay/src/composition/repository.ts`      | Selects SQLite or PostgreSQL without leaking driver types into application services.                                                   |
| Migration ownership          | `apps/relay/src/composition/schema-startup.ts`  | Controller/standalone migrate; dedicated data-plane roles only assert that the schema is current.                                      |
| PostgreSQL backup hook       | `apps/relay/src/composition/postgres-backup.ts` | Creates the pre-migration dump artifact; real dump/restore evidence remains a later release gate.                                      |
| Node transport               | `apps/relay/src/agent-transport.ts`             | CSR enrollment, mTLS connection proof, certificate rotation, drain reconciliation, request lifecycle, remote provider calls, and jobs. |
| Node wire contract           | `packages/contracts/src/agent-protocol.ts`      | Strict versioned envelopes and payload schemas; the reproducible JSON Schema is committed under `contracts/events`.                    |
| Authentication               | `apps/relay/src/auth.ts`                        | Recovery setup, Jellyfin browser identities, role grants, cookies, CSRF, and personal access tokens.                                   |
| Administrative audit         | `apps/relay/src/audited-operation.ts`           | Writes a durable attempt before mutation and a correlated terminal result after it.                                                    |
| Configuration                | `apps/relay/src/config.ts`                      | Environment parsing, safe defaults, explicit proxy CIDRs, and fail-closed production transport validation.                             |
| Core models                  | `packages/domain/src/index.ts`                  | Provider-neutral Zod schemas and inferred TypeScript types.                                                                            |
| Use cases and ports          | `packages/application/src`                      | Provider, profile, VOD, live, audit, cache, metrics, and persistence contracts.                                                        |
| Cluster scheduling           | `packages/application/src/cluster-service.ts`   | Enrollment, node health, placement, certificate state, and lease transitions with bounded CAS retries.                                 |
| Infrastructure adapters      | `packages/adapters/src`                         | Jellyfin, FFmpeg, repositories, object stores, coordination, network policy, and secret stores.                                        |
| Public request/event schemas | `packages/contracts/src/index.ts`               | Runtime request validation shared by the API and dashboard.                                                                            |
| REST description             | `contracts/openapi/vrrelay-v1.yaml`             | Versioned external API used to generate the dashboard transport.                                                                       |
| Dashboard API facade         | `apps/web/src/lib/api.ts`                       | CSRF-aware calls over the generated client; provider setup credentials are not retained in dashboard state.                            |

## VOD request path

1. The API validates a provider-neutral source and immutable profile revision.
2. The application selects an eligible explicitly bound worker.
3. A deterministic content key coalesces identical segment work.
4. The worker resolves the original source locally and runs a structured FFmpeg pipeline.
5. The worker atomically publishes the temporary object.
6. A selected edge verifies the playback grant, caches the object, and serves viewers.

During remote provider setup, the controller may transiently receive and forward a Jellyfin username/password or API key over the authenticated node channel. It never persists those setup credentials. The selected source worker exchanges them for a provider token and writes that token only to its node-local secret store; the controller retains provider-neutral metadata and an opaque binding reference, not the worker-local token. A seek outside a shared window may schedule different bounded work; VRRelay does not claim peer-to-peer delivery.

## Live request path

1. OBS authenticates once against the primary or backup MediaMTX ingest endpoint.
2. The ingest origin normalizes an incompatible stream once when required.
3. Each active edge maintains at most one origin pull for that channel.
4. The edge fans HLS out to its viewers and the controller keeps the public URL stable.

## Persistence and mutation path

1. The controller or standalone root acquires the migration lock and performs any required pre-migration backup before mutation. Dedicated data-plane roles fail closed if the schema is not current.
2. SQLite and PostgreSQL validate a contiguous migration history against fixed version, name, and SHA-256 metadata through v9. The known legacy v1/v2 history is backfilled while the existing migration lock and transaction are held; immutable v4 adds live-channel revisions, v5 adds provider revisions plus the deletion marker, v6 adds durable provider-binding deletion, v7 adds bounded segment-job logs, v8 adds unified user identities, and v9 adds fenced durable VOD producer state and indexes.
3. Schema startup checks the complete required physical shape: tables, columns, primary keys, required unique constraints, and named index column order. Matching only the latest migration number is insufficient.
4. Mutable sessions, nodes, jobs, provider bindings, settings, live channels, and providers use insert/revision/CAS operations. Terminal or protected state changes reject stale revisions and invalid transitions rather than applying broad document overwrites.
5. Session/grant creation atomically guards the referenced live channel or VOD provider. Channel deletion locks the channel and rejects online publishers/dependent sessions; provider deletion rejects dependent VOD sessions or bindings.
6. Provider deletion is resumable and two phase: atomically mark it deletion-pending, delete the node-local secret idempotently, then CAS-finalize after rechecking dependencies. Pending providers are hidden from active reads and cannot be revived by stale validation or new VOD work.
7. Binding creation serializes on the target node and provider. It accepts only an existing, unrevoked source worker and an expected nondeleting provider; binding ownership fields remain immutable. Node removal similarly requires the expected revision, a revoked node, and no bindings.
8. Session/grant creation, session deletion/grant revocation, node/certificate creation, certificate rotation/revocation, provider/binding creation, guarded live-channel deletion, and both provider-deletion transitions use repository transactions.
9. Administrative mutations write an append-only, redacted audit attempt before the operation. The correlated success, failure, or denial record is written afterward; failure to project a terminal record is reported without pretending an already committed mutation was rolled back.

The encrypted file secret store serializes in-process mutations per path and publishes a uniquely named, synced temporary file with restrictive permissions through atomic rename. It deliberately does not claim a cross-process file lock; deployments must assign one writable secret file to one service process.

## Change checklist by boundary

- Model change: update domain schema, persistence migration, fixtures, OpenAPI, and compatibility docs.
- API change: update shared request schema, route, OpenAPI, generated client, dashboard, and tests.
- Adapter change: preserve the application port and add adapter contract coverage.
- Media change: add FFmpeg argument tests plus recorded VRChat evidence before changing compatibility state.
- Cluster change: test standalone behavior, reconnect/restart behavior, and secret locality.
- Deployment change: update the runtime manifest, checksums, operations guidance, and the relevant platform validation.
