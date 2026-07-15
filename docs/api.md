# API and generated client

The external administrative API is versioned under `/api/v1`. Its OpenAPI description is `contracts/openapi/vrrelay-v1.yaml`, while `packages/contracts` contains the Zod schemas that enforce request behavior at runtime.

## Authentication

- Browser administrators use the HTTP-only `vrrelay_session` cookie and send the returned CSRF token on mutations.
- Personal access tokens use `Authorization: Bearer …` and are limited to their recorded scopes.
- Node agents do not use either mechanism. They enroll once, then connect to the dedicated agent listener using a controller-issued mTLS identity.
- Playback uses opaque, session-scoped grants. A playback URL is not an administrator credential.

Public responses must not contain provider secrets, private source URLs, FFmpeg arguments, backend connection strings, certificate private material, or filesystem paths.

`GET /api/v1/backends` returns redacted health for every infrastructure category. Routing backends may be checked with `/backends/validate` and hot-activated with `/backends/activate`. Object-store, repository, coordination, and root-secret changes that cannot be safely hot-swapped report `restartRequired` instead of silently changing the running topology.

Node capability responses report cache usage in bytes, the configured cache limit when present, and `egressMbps` as the trailing 30-second average of media payload bytes actually consumed by clients. Viewer counts remain explicitly estimated; cumulative media byte counters are exact.

`GET /api/v1/cache` and `DELETE /api/v1/cache` operate on the local controller or standalone cache by default. Supplying `nodeId` targets a connected node instead; disconnected targets fail closed rather than falling back to local cache state.

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
