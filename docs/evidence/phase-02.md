# Phase 2 evidence: persistence and runtime decomposition

Date: 2026-07-15

Status: complete. The targeted SQLite/PostgreSQL evidence and the full pinned-runtime repository gate are green.

## Exit-gate scope

| Area                   | Verified behavior                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition            | Controller, source-worker, ingest-origin, edge, and standalone dispatch through distinct composition roots and explicit dependency graphs. Dedicated data-plane servers expose only their owned HTTP routes.                                                                                                                                                                                              |
| Startup                | Controller/standalone run migrations. Dedicated roles perform a read-only schema-current assertion and fail closed when the shared schema is absent or incompatible.                                                                                                                                                                                                                                      |
| Migration integrity    | SQLite and PostgreSQL definitions carry fixed version, name, and SHA-256 metadata through v6. Startup rejects changed definitions, tampered metadata, gaps, future versions, partial metadata, and metadata-free history at v3 or later.                                                                                                                                                                  |
| Schema shape           | Startup checks the exact required column set, storage type/affinity, JSON/JSONB and timestamp representation, nullability, runtime-critical defaults, primary keys, required unique constraints, boolean deletion checks, and named index column order; a correct migration number with a malformed physical schema fails closed.                                                                         |
| Legacy upgrade         | Known v1/v2 history is backfilled during v3 while the SQLite immediate transaction or PostgreSQL advisory lock/transaction is held. Immutable v4 adds live-channel revisions, v5 adds provider revisions plus durable provider deletion, and v6 adds durable binding deletion. Existing-database migration remains behind the configured backup gate.                                                     |
| CAS state              | Sessions, nodes, segment jobs, provider bindings, settings, live channels, and providers use insert/revision/CAS primitives. Session CAS cannot retarget immutable source/profile identity, publisher polling cannot resurrect a deleted channel, and stale validation cannot revive a provider after deletion begins.                                                                                    |
| Session dependencies   | Session/grant creation atomically verifies the referenced live-channel revision or that the VOD provider is present and not deleting. Live-channel deletion locks the channel and rejects online publishers or dependent live sessions; provider deletion rejects dependent VOD sessions.                                                                                                                 |
| Compound writes        | Session/grant creation, session deletion/grant revocation, node/initial-certificate creation, certificate rotation/revocation, provider/binding creation, live-channel deletion, and provider deletion transitions are transactional.                                                                                                                                                                     |
| Provider lifecycle     | Provider creation is insert-only; validation/metadata changes use CAS. Deletion is a resumable two-phase operation: atomically mark deletion pending after dependency checks, remove the secret idempotently, then CAS-finalize only if dependencies remain absent.                                                                                                                                       |
| Provider binding       | Creation serializes on the target node and provider. The node must exist, be an unrevoked source worker, and the provider must match the expected revision/server and not be deleting. Binding IDs are insert-only; provider ID, node ID, and secret-reference ownership are immutable through CAS. Deletion is a durable begin/worker-secret-delete/finalize workflow.                                   |
| Node removal           | Revocation atomically marks owned bindings revoked and unreachable. Physical removal requires the expected revision, a terminal `revoked` state, and no bindings, including deletion-pending records. A disconnected non-revoked node must reconnect for credential cleanup; an orphan on a revoked or removed node requires explicit administrator acknowledgement before controller state is finalized. |
| Secret reconciliation  | Each setup attempt stages a unique node-local token reference. Replayed/concurrent attempts return the committed binding, remove only a confirmed loser, recognize a commit followed by a thrown response, and retain the staged secret when commit status cannot be reconciled safely.                                                                                                                   |
| File secret durability | File-backed encrypted secret mutations serialize per path within one process, publish through a unique synced temporary file and atomic rename, apply restrictive modes, sync the parent directory, and clean failed temporary files without replacing the previous destination.                                                                                                                          |
| Audit                  | An append-only, redacted attempt must persist before an administrative mutation. A correlated terminal success/failure/denial is appended afterward. A terminal projection failure is reported without hiding the authoritative operation result.                                                                                                                                                         |

## Role ownership checked

| Role          | Owned runtime surface                                                                                                                                                       |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controller    | Administrative API/dashboard, auth, audit, provider/profile/session/live orchestration, scheduler, certificate authority, agent controller, backend controls, and director. |
| Source worker | Provider registry and node-local credentials, VOD transcoding/source proxy, cache/job execution, and outbound node agent.                                                   |
| Ingest origin | Live ingest/normalization, MediaMTX management and publisher reconciliation, and outbound node agent.                                                                       |
| Edge          | Playback routes, object restoration, local cache and egress metrics, and outbound node agent; no provider access or transcoder implementation.                              |
| Standalone    | The intentional union of all four roles using the same application ports.                                                                                                   |

## Retained test results

The final real-database Phase 2 matrix ran against **PostgreSQL 17** and completed with **49 of 49 passed, 0 failed**. PostgreSQL-backed cases used two independent repository connections and real transactions; they were not satisfied by a mocked SQL client.

The complete pinned Node 22.23.1 `npm run ci` gate then completed with **235 passed, 23 intentionally skipped, 0 failed** across 33 passing test files and one opt-in suite. Formatting, generated OpenAPI client freshness, every workspace and test-source typecheck, Svelte diagnostics, lint, package/relay/dashboard builds, repository checks, and the moderate-or-higher npm dependency audit all passed; the audit reported zero vulnerabilities.

Together, the retained runs covered:

- v1/v2 upgrade and immutable history validation;
- advisory-lock migration serialization and rollback behavior;
- stale session CAS, job completion/cancellation, and insert-only job replay;
- live-channel CAS polling/deletion and atomic channel/session races;
- provider insert/CAS, dependency guards, terminal deletion, and resumable two-phase deletion;
- durable provider-binding deletion, retry after worker cleanup failure, revoked/missing-node orphan acknowledgement, and scheduling exclusion while deletion is pending;
- durable node drain/revocation, restart registration, and certificate races;
- revoked/dependency-free node removal serialized against binding creation;
- immutable session identity and duplicate certificate-serial parity between SQLite and PostgreSQL;
- single-consumer join tokens and personal-token revocation races;
- atomic node/certificate and provider/binding creation;
- provider/node locking, binding ownership, and staged-secret reconciliation;
- exact schema column/type/nullability/default/check/key/unique/index shape rejection;
- append-only audit ordering/redaction and audit-write failure behavior;
- runtime composition/route ownership and schema-startup policy;
- concurrent encrypted file-secret mutation and atomic publication failure handling.

Equivalent repository behavior is also exercised through two independent SQLite connections, including the immediate migration lock, WAL-consistent pre-migration backup, CAS conflicts, transactional rollback, and immutable history checks.

No connection string, provider credential, token, encryption key, certificate, or database contents are retained in this evidence file.

## Explicitly not proven by Phase 2

- The `pg_dump` wrapper has unit evidence for argument handling, credential redaction, timeouts, checksum validation, permissions, and failed-artifact cleanup. A real dump followed by restore and integrity verification has not yet been retained; that remains Phase 9/10/11 evidence.
- The controller can persist and activate backend configuration, but per-node acknowledgement of which configuration is actually applied is not represented yet. That is Phase 6 edge-delivery work.
- The API supports explicit orphaned-credential acknowledgement for a revoked or removed worker, but the dedicated dashboard recovery workflow remains Phase 7 work.
- Phase 2 does not prove final mTLS enrollment/rotation behavior, distributed job recovery, media compatibility, edge/live failure handling, deployment recovery, native installation, or VRChat playback.
