# Phase 3 implementation checkpoint

Date: 2026-07-15

This checkpoint records the build-first implementation pass for Phase 3: node
identity, agent transport, production security posture, and role isolation. It
is not the final release verification gate.

## Implementation completed

- Node private keys are generated locally. Enrollment uses CSRs and single-use
  join tokens, with retry-safe reuse of the same pending CSR after a lost
  response.
- The controller signs node CSRs without receiving private keys and only
  activates a rotated certificate after the replacement identity reconnects and
  proves itself with a timely hello.
- The outbound agent WebSocket uses mTLS with a strict versioned envelope,
  bounded payloads, replay and timestamp checks, deadlines, typed replies,
  connection-scoped request cleanup, per-connection pending limits, and rate
  limits.
- Drain intent is controller-authoritative and durable. Offline updates persist
  and report `acknowledged: false`; reconnect hello reconciles the node-local
  state.
- Role-specific runtime composition now keeps controller, source-worker,
  ingest-origin, edge, and standalone HTTP surfaces explicit.
- Production startup rejects unsafe public/admin/playback/enrollment/agent URL
  combinations, placeholder secrets, ambiguous proxy trust, and unsupported
  true-like legacy proxy trust.
- Jellyfin requests use DNS-pinned sockets with metadata, link-local, multicast,
  invalid, and IPv4-mapped bypass address rejection. Redirects are blocked.
- FFmpeg source access continues through short-lived loopback grants, with
  internal grants, playback grants, bearer tokens, private URLs, and failure
  context redacted from logs.
- OpenAPI, generated dashboard client, agent protocol schema, deployment
  examples, environment samples, architecture docs, testing docs, and the
  changelog were updated with the new behavior.

## Stabilization fix

The staged-certificate proof path now matches the peer certificate by SHA-256
fingerprint instead of requiring Node's `peer.serialNumber` string to equal the
CA's unsigned hex serial. Node can expose high-bit X.509 serials with a signed
representation, while the DER fingerprint remains canonical.

## Lean guardrails run

These commands passed locally under Node `v22.22.3` and npm `10.9.8` during the
implementation pass.

- `npx vitest run apps/relay/src/agent-transport.test.ts`: 5 passed.
- `npm run format:check`: passed.
- `npm run check`: passed, including OpenAPI freshness, agent protocol schema
  freshness, all workspace typechecks, Svelte diagnostics, test-source typecheck,
  and repository checks.
- `npm run lint`: passed.
- `npm run build`: passed.

The later combined closeout passed the complete `npm run ci` gate under the
pinned Node `22.23.1` runtime: 395 tests passed, 23 intentional skips, all
formatting, generated-client, typecheck, lint, build, and repository gates
passed, and the npm audit reported zero vulnerabilities.

## Deferred verification

The build-first plan intentionally defers broad release verification until the
high-pass testing phase. The following evidence is still pending:

- Docker Compose, container, Kubernetes, Helm, and clean-deployment checks.
- Destructive cluster restart, revocation, drain, and certificate-rotation
  scenarios across real multi-process topologies.
- Public-WSS and private-overlay WSS acceptance evidence.
- Real VRChat, target operating-system, native packaging, signing,
  notarization, SBOM, provenance, and release-artifact evidence.
