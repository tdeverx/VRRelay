# VRRelay Private-Production v1 Completion Ledger

This ledger is the execution record for the repository reconciliation plan. A phase may move to `Complete` only after its exit gate has passed and the retained evidence is linked here. During the build-first pass, a phase may record an `Implementation checkpoint` after code, contracts, docs, and lean guardrails are coherent. That status is not a release claim and does not replace the final high-pass verification gate.

## Execution rules

- Execute implementation slices in plan order, then run a final high-pass verification and defect burn-down before any release-candidate claim.
- Fix compile, contract-generation, migration, or focused happy-path failures in the phase that owns them before starting later work.
- Track broad test, deployment, target-platform, and release-artifact evidence separately when it is intentionally deferred to the final high-pass verification phase.
- Keep credentials, certificates, databases, logs, media, caches, local Codex configuration, and build output out of version control.
- Treat permission, sandbox, Docker, filesystem, and network restrictions as escalation issues rather than product failures.
- Treat genuine compilation, test, runtime, and security failures as gate failures.
- Do not create or push to a public remote before the Phase 12 release-candidate gate.

## Phase status

| Phase                                                   | Status                    | Exit evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Preserve state and establish audit control           | Complete                  | Private pre-implementation source and development-state archives were created, checksummed, and integrity checked on 2026-07-15. Local Codex configuration and development/build artifacts are excluded, and the audited red baseline is recorded below.                                                                                                                                                                                                                         |
| 1. Restore a clean, reproducible baseline               | Complete                  | The checksum-verified Node 22.23.1 runtime passed the full `npm run ci` gate on 2026-07-15: formatting, generated-client freshness, workspace and test-source typechecks, lint, 83 tests with one opt-in integration test skipped, production builds, and a zero-vulnerability npm audit. The initial local baseline commit contains this evidence and is not connected to a public remote.                                                                                      |
| 2. Correct persistence and decompose the runtime        | Complete                  | [Phase 2 evidence](evidence/phase-02.md): role-specific composition, immutable SQLite/PostgreSQL migrations through v6, strict physical-schema validation, transactional/CAS persistence, durable audit records, and crash-safe provider/binding deletion passed focused SQLite tests, a 49-of-49 real PostgreSQL 17 matrix, and the full pinned-runtime CI gate (235 passed, 23 intentional skips, zero failures, zero npm vulnerabilities).                                    |
| 3. Harden node identity, transport, and role isolation  | Implementation checkpoint | [Phase 3 implementation evidence](evidence/phase-03-implementation.md): CSR enrollment, local private-key ownership, proof-activated certificate rotation, strict agent envelopes, durable drain reconciliation, role-minimal HTTP surfaces, production transport/proxy validation, DNS-pinned provider requests, redaction hardening, updated contracts/docs, focused transport tests, format, checks, lint, and build are green. Final high-pass verification remains pending. |
| 4. Finish provider bindings and distributed jobs        | Implementation checkpoint | [Phase 4 implementation evidence](evidence/phase-04-implementation.md): provider playback activity now routes through the healthy connected remote binding instead of resolving worker-local credentials on the controller, and expired distributed segment jobs record the interrupted worker attempt as failed before requeueing. Focused provider-binding/recovery tests, format, checks, lint, and package builds are green. Final high-pass verification remains pending.   |
| 5. Make media profiles and VOD output truthful          | Pending                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6. Complete edge delivery and live fan-out              | Pending                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 7. Finalize APIs and dashboard workflows                | Pending                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 8. Finish observability and operations                  | Pending                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 9. Complete automated verification                      | Pending                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 10. Repair deployments and cloud-neutral infrastructure | Pending                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 11. Complete native packaging and supply-chain evidence | Pending                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 12. Public repository and release gates                 | Pending                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Phase 0 evidence

The private checkpoint is stored outside the repository under the local Codex work area. It is intentionally not a public artifact and may contain encrypted development state.

| Archive                                              |   Size | SHA-256                                                            |
| ---------------------------------------------------- | -----: | ------------------------------------------------------------------ |
| `vrrelay-source-preimplementation.tar.gz`            | 4.3 MB | `060046fd1fb2419dde4dec4dd297690bda1b81c36eb674b0b441ba41f7ce90bb` |
| `vrrelay-development-state-preimplementation.tar.gz` |  30 MB | `59d42f854abef16f0022205ace8f5aa4430b48e0fbb8d182fe7b3e465017cf36` |

Both archives passed gzip integrity validation. Temporary segment cache, dependency directories, compiled output, generated dashboard output, and Git metadata were excluded from the source checkpoint. Persistent `.data` development state was archived separately.

## Audited baseline before implementation

- Git has no commits and no remote; all project files are currently untracked.
- Full TypeScript checks fail in the unfinished metrics exporter.
- Formatting and lint checks each have one known failure in the same unfinished slice.
- Unit tests currently report 76 passed, 2 failed, and 1 skipped; the failures are in stale `BackendService` tests after its constructor changed.
- The generated OpenAPI dashboard client is stale relative to the source contract.
- Dashboard diagnostics and production build pass independently.
- The Windows tray TypeScript check/build and macOS Swift tests/release build pass independently.
- Compose syntax checks pass, but the multi-host Compose topology has known semantic profile and port inheritance defects.
- A current Docker integration result cannot be claimed while the repository build is red.
- Helm and final-artifact security evidence have not yet been rerun as part of this execution.
- A targeted non-ignored-source scan found none of the known temporary Jellyfin credentials, private LAN fixture identifiers, private-key headers, or common AWS access-key patterns.

## Public milestones

- **Feature-complete public release candidate:** all documented v1 behavior is implemented, automated checks are green, deployment artifacts are reproducible, and unverified external compatibility is labelled accurately.
- **Supported v1 release:** the release candidate also passes required real VRChat PC testing, target-platform installation checks, security scans, destructive cluster scenarios, and any compatibility specifically claimed for Quest.

## Phase 1 evidence

- Completed the partially integrated object-store and metrics backend slice, including safe exporter replacement, shutdown, authenticated webhook activation, persisted configuration ordering, and delivery-failure health reporting.
- Added focused metrics/backend tests and updated stale test fixtures.
- Added a dedicated ESM/ES2024 TypeScript check for colocated test sources.
- Regenerated the OpenAPI dashboard client and added a non-mutating byte-for-byte freshness gate that detects changed, missing, and obsolete generated files.
- Added explicit GPL-3.0-or-later metadata to every workspace package and refreshed the package lockfile.
- Expanded the environment example to cover the runtime's currently supported configuration without embedding credentials.
- Recast the README, changelog, and implementation status as an audited prerelease foundation.
- A redacted Gitleaks 8.30.1 scan of the version-controlled candidate found no source-tree leaks. Local acceptance-harness secrets were found only under the ignored `.data` directory and were not staged.
- The dependency license inventory found explicit metadata for every dependency except `svelte-toolbelt`; its installed `LICENSE` file is MIT. The dual-licensed `node-forge` dependency is usable under its BSD-3-Clause option.
