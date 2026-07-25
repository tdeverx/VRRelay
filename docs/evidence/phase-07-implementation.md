# Phase 7 implementation checkpoint — generated API and operator workflows

Date: 2026-07-25

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
- The current sessions page exposes copy and revocation, the supported durable
  session actions. Deletion uses a shared confirmation with pending and
  recoverable error states. Earlier stop/resume, pin, detail, and output
  selection controls described by this checkpoint are no longer active UI.
- The advanced administrator VOD workflow loads online source workers
  compatible with an administrator-managed provider connection and encoder,
  previews scheduler placement, supports region and exact worker preferences,
  and displays explicit placement rejection reasons before creation. Delegated
  Jellyfin users continue to use the role-aware catalog workflow with their
  session credential. Connections now exposes explicit delegated, stored user
  token, and stored API-key modes so the advanced workflow is not dependent on
  an API-only setup path. The advanced UI sends `preferredNodeId` only while
  exact-worker lock is on; the server derives and persists `placementLocked`
  from that preference before resolving the same worker.
- The application shell now has a working persisted navigation-collapse state,
  a visible-on-focus skip link, mobile open/close focus transfer, Escape
  dismissal, and an accessible collapsed-navigation label.
- The current jobs-and-cache page exposes controller-local inventory and
  confirmed bulk eviction. Earlier remote cache targeting described by this
  checkpoint is no longer an active dashboard workflow.
- Storage & routing now exposes the existing structured backend validation and
  activation APIs. Operators choose routing, metrics, or object-store fields,
  reference pre-provisioned secrets by name rather than value, validate the
  unchanged configuration, and confirm activation. Object-store activation
  remains explicitly staged until every role restarts.
- Jobs expose bounded redacted logs, retry, and confirmed cancellation; revoked
  node records expose confirmed removal while the server continues to refuse
  removal when provider bindings remain.
- The production-build Playwright suite covers theme persistence, responsive
  loading geometry, every administrator destination, safe authentication
  returns, degraded readiness, settings read-only behavior, PAT expiry and
  confirmed revocation, mobile navigation dismissal, persisted desktop
  collapse, complete advanced relay creation and Sessions handoff, recovery
  and Jellyfin roles, clipboard-denied partial success, and confirmed session
  revocation. Every page is monitored for uncaught browser errors, and route
  coverage retains serious/critical WCAG A/AA Axe checks.

## Verification state

The expanded current-worktree suite was run on 2026-07-25. Desktop Chromium
passed 13 workflows with one intentional skip, and mobile Chromium independently
passed the same 13 workflows with one intentional skip. The suite covered every
administrator destination, route-specific titles, safe authentication returns,
degraded diagnostics, nonmutating settings navigation, confirmed backend and PAT
mutations, mobile dismissal, persisted desktop collapse, placement validation,
and recovery/Jellyfin roles. No workflow test failed.

The same checkout passed formatting, generated-client freshness, contract
semantics, workspace and test-source typechecks, Svelte diagnostics, repository
and deployment guards, lint, and production builds. The full Vitest run passed
474 tests across 47 files, with 25 intentional skips and one skipped file.

## Deferred to broader release qualification

- Full browser execution of live, provider-binding/failover, job history,
  certificates, metrics, compatibility, and realtime log/event workflows.
- Browser and destructive multi-process proof that exact locked placement
  remains stable through worker loss and scheduler execution.
- Broader keyboard/table interaction and focus-managed confirmation coverage
  across every administrator route.
