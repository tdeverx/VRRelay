# Phase 7 implementation checkpoint — generated API and operator workflows

Date: 2026-07-16

This is a build-first implementation checkpoint for the generated API boundary
and several administrator workflows. It is not evidence that every dashboard,
browser, accessibility, realtime, or release-candidate workflow is complete.

## Scope completed

- The dashboard API facade now invokes operation-specific functions from the
  generated OpenAPI SDK. Generated code owns paths, methods, query
  serialization, and request bodies; the handwritten layer is limited to
  authentication/CSRF interceptors, normalized errors, and small
  domain-facing conveniences. The repository check rejects literal API paths or
  use of the generated client's generic request method in that facade.
- The sessions page now exposes stop/resume, pin/unpin, deletion with
  confirmation, details, output selection, and copy-link controls while keeping
  visible pending and error states.
- The new VOD workflow loads online source workers compatible with the selected
  provider and encoder, previews scheduler placement, supports region and exact
  worker preferences, and displays explicit placement rejection reasons before
  creation. The UI sends `preferredNodeId` only while exact-worker lock is on;
  the server derives and persists `placementLocked` from that preference before
  resolving the same worker.
- The application shell now has a working persisted navigation-collapse state,
  a visible-on-focus skip link, mobile open/close focus transfer, Escape
  dismissal, and an accessible collapsed-navigation label.
- The cluster cache panel continues to target either controller-local cache or
  a connected source-worker/edge cache. It falls back to local cache if the
  selected node disconnects or loses its cache-owning role, and sends `nodeId`
  only for explicit remote inventory/eviction operations.
- Playwright now runs two administrator workflows against desktop Chromium and
  a Pixel 7-sized mobile project: first-run setup/login/responsive navigation,
  and scoped PAT creation/revocation/logout. The tests fail on browser page
  errors and on serious or critical WCAG A/AA Axe findings. CI builds the app,
  installs Chromium, runs the suite, and retains failure artifacts.

## Focused verification

Commands observed in this closeout:

```text
npx playwright test
```

Result: all four project cases passed (two workflows on desktop and mobile),
with no captured page errors and no serious or critical Axe violations.

The complete combined closeout also passed `npm run ci` under the pinned Node
`22.23.1` runtime: 395 tests passed, 23 intentional skips, all formatting,
generated-client, typecheck, lint, build, and repository gates passed, and the
npm audit reported zero vulnerabilities.

## Deferred to the final high-pass verification

- Full browser execution of session mutation, placement submission, catalog,
  live, provider-binding/failover, job history, cache, certificates, metrics,
  compatibility, and realtime log/event workflows.
- Browser and destructive multi-process proof that exact locked placement
  remains stable through worker loss and scheduler execution.
- Broader keyboard/table interaction and focus-managed confirmation coverage
  across every administrator route.
