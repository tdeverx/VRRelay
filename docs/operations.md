# Private-production operations

## Enrollment and networking

Create a single-use join token in **Cluster → Enroll node**, select the exact roles, and transfer it to the target node once. The node exchanges it at the enrollment URL, stores the returned identity in its platform secret backend, then uses only outbound mTLS WebSockets. Remove `VRRELAY_NODE_JOIN_TOKEN` after enrollment. Certificates rotate automatically during the last 48 hours of their seven-day lifetime.

The protocol is identical over public WSS and private overlays. Public mode needs TCP 8100 forwarded to the controller agent listener and the public DNS name in `VRRELAY_AGENT_TLS_NAMES`. Overlay mode uses the overlay address in `VRRELAY_CONTROLLER_AGENT_URL`. Workers, origins, and edges need no inbound management port.

## Health and readiness

Use `/api/v1/health` for process liveness and `/api/v1/ready` for dependency
readiness. Readiness returns HTTP 503 when repository, coordination,
object-store, routing, metrics, or restart-required backend state is not ready,
but it only exposes redacted dependency category/kind/status fields.

## Traffic director

The default director performs capacity-aware, stable session hashing locally. **Cluster → Configure routing** can also validate and activate static routing without restarting the controller. Static routing can pin traffic to one configured edge node or to an online edge in a configured region; a pinned node fails closed if it is offline, no longer has the edge role, or does not match the request's preferred region.

For external policy engines, **Cluster → Configure routing** can validate and activate a generic webhook without restarting the controller. Public endpoints must use HTTPS; private-network HTTP is accepted with the same SSRF and credential-in-URL checks as provider connections. An optional `secretRef` names a bearer token already provisioned in the controller's root secret backend—the secret value is never stored in distributed configuration or returned by the API.

VRRelay sends `{"type":"health"}` for validation. Selection requests contain `type: "select-edge"`, the session and preferred region, and only eligible edges with public routing/capacity fields. Return `{"nodeId":"…"}` for one supplied candidate. Unknown, offline, or otherwise ineligible IDs are rejected.

## Backup, restore, upgrade, and rollback

Back up PostgreSQL with `deploy/docker/backup.sh`, object-store configuration, TLS material, and each node's secret backend. Valkey is coordination state, not the authoritative backup. Test restores in an isolated cluster.

Before upgrading, take a backup and verify release checksums/SBOM. Drain non-controller roles one at a time, upgrade the single controller, then agents. Keep the previous artifacts and backup until VRChat smoke tests pass. Roll back binaries only with a compatible schema; otherwise restore the matching pre-upgrade database and node data. Native uninstallers retain data unless explicitly purged.

After controller restart, sessions and queued jobs remain in PostgreSQL. Expired leases can be reassigned; completed object keys are checked before new work. Object-store failures leave partial objects hidden. Certificate revocation is persisted and closes the live agent socket.

## Metrics and privacy

Set a dedicated 32-character-or-longer `VRRELAY_METRICS_TOKEN`. Viewer counts are estimates: VRRelay HMACs IP/user-agent pairs with an installation-local salt and expires activity after 30 seconds. Relay byte counters are exact.

## Node logs and events

Agent log messages are structured, redacted by the controller, stored per node,
and emitted as `node.log` messages on the authenticated operations event stream.
`VRRELAY_AGENT_LOG_RETENTION_ROWS` controls how many recent log rows are kept per
node, and `VRRELAY_AGENT_LOG_QUERY_LIMIT` caps `/api/v1/nodes/{nodeId}/logs`
responses even when callers request a larger `limit`.
