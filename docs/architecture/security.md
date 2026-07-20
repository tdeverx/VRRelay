# Security model

The dashboard uses one HTTP-only same-site session cookie and CSRF companion cookie for both Jellyfin and recovery-owner sign-in. The first-run local password is hashed with Argon2id and remains an owner recovery path; it does not provide a personal media catalog. Jellyfin identities are persisted under a stable provider-and-user hash with explicit local user, operator, admin, or owner grants. Jellyfin administrator status is never trusted as a VRRelay grant, the last assigned owner cannot be demoted, and current grants are resolved during authorization so changes apply immediately. A Jellyfin password is used only for the login exchange and is never persisted; the returned token is stored in the configured secret backend for the browser session. Each user-created relay receives a separate session-owned token copy, allowing logout without invalidating an existing playback link. User session reads and controls are restricted to their stable owner identity, while operators receive the system-wide view. Personal access tokens remain separate hashed, scoped, revocable machine identities.

Playback and one-time OBS publisher connection details contain opaque random grants instead of Jellyfin credentials. User-created OBS channels are assigned to the current stable identity on the server; user reads and mutations are ownership-filtered, while operators receive the system-wide view. Controller playlists mint signed, session-scoped edge playback grants for the selected edge instead of reusing the administrator-facing playback token in edge segment URLs. Edge requests verify the signed grant against the durable playback grant, so session deletion or grant revocation stops already minted edge links. Stored live-channel URLs are credential-free, and public channel summaries omit both ownership metadata and publisher-token hashes.

Shared administrator Jellyfin credentials, where retained for legacy connections or remote provider bindings, are used only for the initial authentication exchange. The password is discarded, and the returned user token is stored in the selected node-local secret backend: macOS Keychain, Windows DPAPI, a Kubernetes-provided secret, or an AES-256-GCM encrypted file. API-key authentication is available as explicitly broad service mode.

Cluster nodes generate their private keys locally, persist a pending key and CSR in
their node-local secret backend, and enroll with that CSR plus a single-use hashed
join token. The controller signs the CSR without receiving the private key. Exact
enrollment retries recover the same identity for a short bounded window; a
different CSR cannot reuse the consumed token.

The outbound agent WebSocket uses mTLS and a strict versioned envelope contract.
Messages are size bounded, rate limited, sequenced, timestamped, deadline checked,
and acknowledged with typed success or error payloads. A socket cannot replace the
registered connection until its certificate-bound node ID completes hello proof.
Correlated request listeners and abort handlers are scoped to the connection and
removed on success, error, timeout, abort, disconnect, or shutdown.

Persistent VOD production uses explicit `producer.start` and `producer.stop` commands and requires
the `vodProducerVersion: 1` capability. A signed-in user's session-owned token is carried only in
the typed mTLS start payload, held only in source-worker memory, excluded from FFmpeg arguments and
logs, and discarded when ownership ends. FFmpeg continues to read only an opaque loopback source
grant while Node performs the authenticated provider request.

Node certificates rotate continuously 48 hours before expiry. The node durably
records the replacement key and CSR before requesting a signature; the controller
stages one exact certificate, and only a reconnect proving possession activates it.
Activation transactionally revokes the old certificate and closes the old socket.
Expired, revoked, superseded, or abandoned candidate identities cannot become or
remain the registered agent. Public-DNS and private-overlay endpoints use the same
outbound mTLS WSS protocol and certificate checks.

Drain is controller-authoritative and durable. The controller persists the desired
state before issuing an explicit command, the node persists it locally before
acknowledging, reconnect hello reconciles either side after restart, and a drained
node rejects new jobs. Provider bindings are created explicitly on selected source
workers and are never copied by placement logic.

Provider URLs are resolved before use. Metadata endpoints are blocked, public HTTP requires an explicit unsafe override, and private HTTP remains visibly warned. Raw FFmpeg fragments are never accepted. FFmpeg is spawned without a shell and receives only validated structured settings.

Every Jellyfin connection performs a fresh DNS resolution, rejects metadata,
link-local, multicast, unspecified/invalid, and IPv4-mapped bypass addresses, and pins one validated
result to the actual HTTP/TLS socket while preserving the approved hostname for
Host and TLS verification. Provider redirects are never followed and
authorization is never forwarded to a redirect target.

Jellyfin authorization headers are not placed in FFmpeg arguments. The relay creates a short-lived, opaque loopback source grant; FFmpeg reads that internal URL while Node performs the authenticated upstream request. API responses and logs never expose the source URL, secret reference, token, internal path, or FFmpeg arguments. Structured request logging redacts playback and internal source grants from URL paths, omits raw client addresses and user agents, and correlates playback with short one-way client trace IDs. Mutation logs contain only the already-redacted durable audit projection and never serialize request bodies.

Quest-facing playback requires a publicly trusted HTTPS certificate. Compose includes an optional Caddy ACME mode; manual-certificate and external reverse-proxy modes are also supported. The relay and agent WebSocket must receive the correct proxy headers and WebSocket upgrade handling, and internal source routes must never be exposed separately.

`VRRELAY_ENVIRONMENT=production` fails closed unless canonical public,
administration, and playback URLs use HTTPS, data-plane enrollment uses HTTPS,
agent transport uses WSS, placeholder secrets are replaced, and reverse-proxy
trust is expressed as explicit CIDRs. A dedicated controller exposes the
administrative and clean manifest/routing surface but not local source, ingest,
segment, or live-media routes. Source grants remain loopback-only; MediaMTX auth
accepts only raw-socket loopback or private-network peers and does not trust
forwarded client addresses. Credential-free MediaMTX reads are limited to the
private RTSP normalizer path; HLS and other playback protocols require the
configured read identity.

Regional routing accepts the configured viewer-region header only from the raw socket peer when it
matches `VRRELAY_TRUSTED_PROXY_CIDRS`. The request must contain exactly one syntactically valid
value that exactly matches a configured node-region label. Untrusted, duplicate, malformed, and
unknown values are ignored and counted with a bounded fallback metric. Raw client IP addresses are
not passed to the application routing contract or webhook.

Upgrades may temporarily retain a false-like `VRRELAY_TRUST_PROXY` value from
the previous sample environment; it is treated as a no-op so existing
standalone installs still start. True or ambiguous values fail closed. Remove
the legacy variable and use `VRRELAY_TRUSTED_PROXY_CIDRS` for any trusted proxy.
