# Private-production operations

## Enrollment and networking

Create a single-use join token in **Cluster → Enroll node**, select the exact roles, and transfer it to the target node once. The node exchanges it at the enrollment URL, stores the returned identity in its platform secret backend, then uses only outbound mTLS WebSockets. Remove `VRRELAY_NODE_JOIN_TOKEN` after enrollment. Certificates rotate automatically during the last 48 hours of their seven-day lifetime.

The protocol is identical over public WSS and private overlays. Public mode needs TCP 8100 forwarded to the controller agent listener and the public DNS name in `VRRELAY_AGENT_TLS_NAMES`. Overlay mode uses the overlay address in `VRRELAY_CONTROLLER_AGENT_URL`. Workers, origins, and edges need no inbound management port.

## Health and readiness

Use `/api/v1/health` for process liveness and `/api/v1/ready` for dependency
readiness. Readiness returns HTTP 503 when repository, coordination,
object-store, routing, metrics, or restart-required backend state is not ready,
but it only exposes redacted dependency category/kind/status fields.
Controller and standalone readiness evaluates the configured backend aggregate;
standalone additionally requires its managed or external MediaMTX API.
Dedicated source-worker and edge roles also require an established controller
agent connection; ingest-origin readiness additionally requires its managed
MediaMTX process and API, while edge readiness requires the configured MediaMTX
API. Public HTTP is bound only after critical local resources have started, so
a startup failure cannot briefly expose a nominally live role server.

The native menu/tray controller polls liveness without adding each successful probe to the request
log. macOS service output rolls at 10 MiB and retains eight historical files beside
`~/Library/Logs/VRRelay/service.log`; Windows uses the equivalent WinSW rolling-log policy.
Set **Settings → Runtime → Diagnostic logging** to **Detailed playback tracing** while reproducing
an issue. Normal mode records client starts, resumes, seeks, routing decisions, source-range opens,
and accepted or rejected API mutations. Detailed mode additionally records sequential/retried
segment traffic and range completions. Correlate entries with `reqId`, `sessionId`, and the short
one-way `clientId`; raw client addresses, user agents, grants, credentials, request bodies, and
private source URLs are not logged. Return the setting to normal after testing to reduce volume.

An exact LAN listener remains compatible with the loopback-only source-grant boundary: VRRelay
opens a private companion listener on `127.0.0.1` at the same port for internal media requests.
Wildcard and loopback listeners already accept that traffic and do not create a second listener.
On macOS, **Quit VRRelay** stops the LaunchAgent before the menu controller exits. Windows applies
the same rule to **Quit VRRelay (stops relay)**. If stopping fails or elevation is cancelled, the
controller remains open and reports the failure instead of leaving a hidden runtime behind.

## Standalone worker state

The standalone node is the local source worker and does not start or connect back to a cluster
agent listener. It registers and begins heartbeating during ordinary application startup without
certificate enrollment or platform secret-store setup. Draining it prevents new local placement.
Use **System → Nodes → Resume local worker** to return a draining standalone node to service. The
New relay wizard validates Local placement against the node's online state, encoder support, and
locally available provider credentials before it enables the review step.

## Traffic director

The default director performs capacity-aware, stable session hashing locally. **Cluster → Configure routing** can also validate and activate static routing without restarting the controller. Static routing can pin traffic to one configured edge node or to an online edge in a configured region; a pinned node fails closed if it is offline, no longer has the edge role, or does not match the request's preferred region.

For external policy engines, **Cluster → Configure routing** can validate and activate a generic webhook without restarting the controller. Public endpoints must use HTTPS; private-network HTTP is accepted with the same SSRF and credential-in-URL checks as provider connections. An optional `secretRef` names a bearer token already provisioned in the controller's root secret backend—the secret value is never stored in distributed configuration or returned by the API.

VRRelay sends `{"type":"health"}` for validation. Selection requests contain `type: "select-edge"`, the session and preferred region, and only eligible edges with public routing/capacity fields. Return `{"nodeId":"…"}` for one supplied candidate. Unknown, offline, or otherwise ineligible IDs are rejected.

## Backup, restore, upgrade, and rollback

Back up PostgreSQL or SQLite with `deploy/docker/backup.sh`, object-store configuration, TLS material, and each node's secret backend. Set `VRRELAY_REPOSITORY_DRIVER=postgres` with `POSTGRES_URL`, or `VRRELAY_REPOSITORY_DRIVER=sqlite` with `SQLITE_PATH` or `VRRELAY_DATA_DIR`. The script writes private atomic artifacts, validates schema metadata, writes `.sha256` and `.meta` sidecars, and can encrypt artifacts when `BACKUP_ENCRYPTION_PASSPHRASE_FILE` points at an operator-managed passphrase file. `deploy/docker/restore.sh` verifies checksums when sidecars are present and creates a rollback backup before destructive restore unless `RESTORE_SKIP_ROLLBACK_BACKUP=1` is set explicitly. For SQLite restores, stop VRRelay first and set `RESTORE_RELAY_STOPPED=1`; PostgreSQL restores run through `pg_restore --single-transaction --exit-on-error`. Valkey is coordination state, not the authoritative backup. Test restores in an isolated cluster.

Before upgrading, take a backup and verify release checksums/SBOM. Drain non-controller roles one at a time, upgrade the single controller, then agents. Keep the previous artifacts and backup until VRChat smoke tests pass. Roll back binaries only with a compatible schema; otherwise restore the matching pre-upgrade database and node data. Native uninstallers retain data unless explicitly purged.

After controller restart, sessions and queued jobs remain in PostgreSQL. Expired leases can be reassigned; completed object keys are checked before new work. Object-store failures leave partial objects hidden. Certificate revocation is persisted and closes the live agent socket.

## Metrics and privacy

Set a dedicated 32-character-or-longer `VRRELAY_METRICS_TOKEN`. Viewer counts are estimates: VRRelay HMACs IP/user-agent pairs with an installation-local salt and expires activity after 30 seconds. Relay byte counters are exact. The Sessions dashboard combines those estimates with short-lived per-node source ingress, viewer egress, producer throughput, and cache snapshots; it does not persist viewer identities or add session IDs to metrics labels.

## Node and job logs

Agent log messages are structured, redacted by the controller, stored per node,
and emitted as `node.log` messages on the authenticated operations event stream.
`VRRELAY_AGENT_LOG_RETENTION_ROWS` controls how many recent log rows are kept per
node, and `VRRELAY_AGENT_LOG_QUERY_LIMIT` caps `/api/v1/nodes/{nodeId}/logs`
responses even when callers request a larger `limit`.

Segment job messages use the same redaction rules, are stored per job, and are
emitted as `job.log` messages on the authenticated operations event stream.
`VRRELAY_JOB_LOG_RETENTION_ROWS` controls how many recent rows are kept per job,
and `VRRELAY_JOB_LOG_QUERY_LIMIT` caps `/api/v1/jobs/{jobId}/logs` responses.

## Live admission and supervision

Live channel creation is bounded by `VRRELAY_LIVE_MAX_CHANNELS_TOTAL` (default 32) and `VRRELAY_LIVE_MAX_CHANNELS_PER_OWNER` (default 4). Normalized live
channels also share `VRRELAY_LIVE_NORMALIZER_MAX_CONCURRENT` (default 2), while
`VRRELAY_LIVE_NORMALIZER_MAX_PER_OWNER` (default 1) prevents one owner from
consuming every normalizer slot.
Normalizer children drain stderr, apply bounded exponential restart backoff,
and receive TERM followed by KILL during forced shutdown. Raise these limits
only after measuring CPU, memory, ingest bandwidth, and restart behavior on the
target host.

Edge live-path configuration is demand-managed. Idle paths are deleted from
MediaMTX after the configured stale interval and are recreated on later demand;
failed upstream pulls are deleted and retried immediately. Live manifests and
grant-bearing live segments are served with `no-store`, so deletion or grant
revocation is revalidated at VRRelay rather than bypassed by an intermediary
cache.

## Benchmark runs

Use `npm run benchmark -- --scenario <name>` for reproducible playlist,
cached-egress, uncached-encode, live-fan-out, cache-ratio, and resource-snapshot
checks. Benchmark output includes sanitized target metadata and CPU/RAM/GPU
resource snapshots so retained evidence can be compared against the exact host
and scenario that produced it. Treat the numbers as environment evidence, not a
portable viewer-limit guarantee. Release-candidate runs should add
`--fail-on-errors --output <unique-report.json>`. Add
`--fail-on-regression --baseline <baseline.json>` only when the baseline has the
same scenario and load configuration; the resulting report records the baseline
digest and the command exits nonzero when the enforced gate fails.
