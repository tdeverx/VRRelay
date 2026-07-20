# API and generated client

The external administrative API is versioned under `/api/v1`. Its OpenAPI description is `contracts/openapi/vrrelay-v1.yaml`, while `packages/contracts` contains the Zod schemas that enforce request behavior at runtime.

## Authentication

- Jellyfin users and recovery owners use the HTTP-only `vrrelay_session` cookie and send the returned CSRF token on mutations. Effective roles are returned by `/auth/me` and enforced on every request.
- Personal access tokens use `Authorization: Bearer …` and are limited to their recorded scopes.
- Node agents do not use either mechanism. They enroll once, then connect to the dedicated agent listener using a controller-issued mTLS identity.
- Playback uses opaque, session-scoped grants. A playback URL is not an administrator credential.

Public responses must not contain provider secrets, private source URLs, FFmpeg arguments, backend connection strings, certificate private material, or filesystem paths.

`GET /api/v1/catalog` accepts the provider-neutral `section` values `continue_watching`, `next_up`,
and `recently_added` in addition to hierarchy and search queries. Provider adapters translate those
sections into their native discovery APIs. Media items may include a saved playback position and
percentage for progress presentation.
Jellyfin catalog responses exclude virtual, missing, and placeholder entries; movies and episodes
must expose at least one media source, while empty shows and seasons are omitted when Jellyfin
reports that they contain no descendants.

The administrator-owned interactive sign-in configuration includes `reportPlaybackActivity`.
Signed-in users cannot override this policy when creating a VOD session. Disabling it prevents all
provider playback start, progress, and stop calls while retaining VRRelay's own viewer, session,
producer, and request diagnostics.

`GET /api/v1/health` is lightweight liveness. `GET /api/v1/ready` is
dependency-aware readiness for orchestrators: it returns 503 when a backend
dependency is unhealthy or a staged backend change requires restart, and it
omits backend error messages so private endpoints and filesystem paths are not
exposed publicly.

`GET /api/v1/backends` returns redacted health for every infrastructure category. Routing backends may be checked with `/backends/validate` and hot-activated with `/backends/activate`. Object-store, repository, coordination, and root-secret changes that cannot be safely hot-swapped report `restartRequired` instead of silently changing the running topology.

`GET /api/v1/configuration/runtime` returns an allowlisted, non-secret view of listener and
advertised URLs, proxy CIDRs, the trusted viewer-region header, agent listener, encoder/cache
limits, VOD producer idle timeout, low/high producer buffer watermarks, producer concurrency and
per-provider caps, and node labels. Validation and
updates require administrator authentication plus browser CSRF protection. Updates are writable
only when the service manager explicitly supplies `VRRELAY_RUNTIME_CONFIG`; explicit deployment
environment variables retain precedence. `/configuration/runtime/restart` is available only when
the supervisor opts into exit-based restart with `VRRELAY_RESTART_MODE=exit`.

Node capability responses report cache usage in bytes, the configured cache limit when present, and `egressMbps` as the trailing 30-second average of media payload bytes actually consumed by clients. Viewer counts remain explicitly estimated; cumulative media byte counters are exact.

`GET /api/v1/sessions` returns both the authorized session list and a matching array of short-lived
runtime snapshots. These snapshots expose estimated 30-second viewers, derived activity,
producer/window and catch-up/buffered state, transcode realtime factor, upstream source connection
and request counts, source ingress, viewer egress, and delivery-cache
counts. They contain no client identity, source URL, provider credential, or unbounded Prometheus
label and expire naturally when a node stops reporting.

Profiles may set `audio.defaultLanguage` to an ISO 639-2 or BCP-47 language. A VOD session resolves
that preference when no `audioTrackId` is supplied; an explicit track remains authoritative.

`GET /api/v1/vod-producers` gives administrators a redacted list of durable producer ownership,
generation, state, playback window, demand age, and failure data. `GET
/api/v1/vod-producers/{sessionId}` applies the same session ownership rules as session detail. No
provider token, source URL, grant, or FFmpeg argument is returned.

`GET /api/v1/cache` and `DELETE /api/v1/cache` operate on the local controller or standalone cache by default. Supplying `nodeId` targets a connected node instead; disconnected targets fail closed rather than falling back to local cache state.

Live channel responses include selected ingest-origin metadata when available
and include `normalizationProfileId`/`normalizationProfileRevision` after a
normalized channel is pinned to the first live-session profile. Jellyfin browser sessions create
user-owned channels: list and mutation routes filter by the current stable identity, while
operators, administrators, owners, and appropriately scoped personal tokens use the system-wide
view. Ownership is assigned server-side and is not part of the public channel response.
For standalone/native defaults, loopback RTMP, SRT, and WHIP hosts are re-advertised with the
configured public relay hostname. Explicit non-loopback ingest URLs continue to override this
derivation.

## Changing the API

1. Change or add the request schema in `packages/contracts`.
2. Update the route in `apps/relay/src/server.ts`.
3. Update OpenAPI, including authentication, parameters, request body, success response, and standard errors.
4. Regenerate the client with `npm run generate:api`.
5. Use the generated transport and shared domain/contract types in `apps/web/src/lib/api.ts`.
6. Add route/use-case tests and update documentation or the changelog.

The WebSocket event and agent-envelope shapes are versioned separately in
`contracts/events`. The node-agent protocol is an internal cluster protocol even
though its enrollment and connection endpoints appear in OpenAPI. Its strict
runtime envelope and payload schemas live in
`packages/contracts/src/agent-protocol.ts`; run
`npm run generate:agent-protocol-schema` after changing them, and commit the
reproducible JSON Schema update with the TypeScript contract.
