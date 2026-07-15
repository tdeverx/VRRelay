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

| Concern                      | Start here                                    | Notes                                                                                                    |
| ---------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Process composition          | `apps/relay/src/main.ts`                      | Loads configuration, selects adapters, starts controller or agent roles, and performs shutdown.          |
| HTTP and playback routes     | `apps/relay/src/server.ts`                    | Authentication, API request validation, public playback URLs, MediaMTX callback, and embedded dashboard. |
| Node protocol                | `apps/relay/src/agent-transport.ts`           | mTLS controller and outbound agent connection, sequencing, deadlines, remote provider calls, and jobs.   |
| Authentication               | `apps/relay/src/auth.ts`                      | First-run administrator, cookies, CSRF, and personal access tokens.                                      |
| Configuration                | `apps/relay/src/config.ts`                    | Environment parsing and safe defaults.                                                                   |
| Core models                  | `packages/domain/src/index.ts`                | Provider-neutral Zod schemas and inferred TypeScript types.                                              |
| Use cases and ports          | `packages/application/src/services.ts`        | Provider, profile, VOD session, live, cache, and metrics orchestration.                                  |
| Cluster scheduling           | `packages/application/src/cluster-service.ts` | Enrollment, node health, bindings, placement, certificate state, and leases.                             |
| Infrastructure adapters      | `packages/adapters/src`                       | One file per external integration; exported through `index.ts`.                                          |
| Public request/event schemas | `packages/contracts/src/index.ts`             | Runtime request validation shared by the API and dashboard.                                              |
| REST description             | `contracts/openapi/vrrelay-v1.yaml`           | Versioned external API used to generate the dashboard transport.                                         |
| Dashboard API facade         | `apps/web/src/lib/api.ts`                     | CSRF-aware calls over the generated client; no provider credentials are retained.                        |

## VOD request path

1. The API validates a provider-neutral source and immutable profile revision.
2. The application selects an eligible explicitly bound worker.
3. A deterministic content key coalesces identical segment work.
4. The worker resolves the original source locally and runs a structured FFmpeg pipeline.
5. The worker atomically publishes the temporary object.
6. A selected edge verifies the playback grant, caches the object, and serves viewers.

The controller never receives a Jellyfin password or worker-local provider token. A seek outside a shared window may schedule different bounded work; VRRelay does not claim peer-to-peer delivery.

## Live request path

1. OBS authenticates once against the primary or backup MediaMTX ingest endpoint.
2. The ingest origin normalizes an incompatible stream once when required.
3. Each active edge maintains at most one origin pull for that channel.
4. The edge fans HLS out to its viewers and the controller keeps the public URL stable.

## Change checklist by boundary

- Model change: update domain schema, persistence migration, fixtures, OpenAPI, and compatibility docs.
- API change: update shared request schema, route, OpenAPI, generated client, dashboard, and tests.
- Adapter change: preserve the application port and add adapter contract coverage.
- Media change: add FFmpeg argument tests plus recorded VRChat evidence before changing compatibility state.
- Cluster change: test standalone behavior, reconnect/restart behavior, and secret locality.
- Deployment change: update the runtime manifest, checksums, operations guidance, and the relevant platform validation.
