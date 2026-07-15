# Security model

The dashboard uses a first-run administrator password hashed with Argon2id, an HTTP-only same-site cookie, and CSRF tokens for mutations. Personal access tokens are hashed, scoped, revocable records. Playback and one-time OBS publisher connection details contain opaque random grants instead of Jellyfin credentials. Stored live-channel URLs are credential-free, and public channel summaries omit the publisher-token hash.

Jellyfin user credentials are used only for the initial authentication exchange. The password is discarded, and the returned user token is stored in the selected node-local secret backend: macOS Keychain, Windows DPAPI, a Kubernetes-provided secret, or an AES-256-GCM encrypted file. API-key authentication is available as explicitly broad service mode.

Cluster nodes enroll with a single-use hashed join token and then use rotating mTLS identities over the outbound agent WebSocket. The certificate identity is bound to the node ID, replayed sequence numbers and expired deadlines are rejected, and revocation closes a connected agent. Provider bindings are created explicitly on selected source workers and are never copied by placement logic.

Provider URLs are resolved before use. Metadata endpoints are blocked, public HTTP requires an explicit unsafe override, and private HTTP remains visibly warned. Raw FFmpeg fragments are never accepted. FFmpeg is spawned without a shell and receives only validated structured settings.

Jellyfin authorization headers are not placed in FFmpeg arguments. The relay creates a short-lived, opaque loopback source grant; FFmpeg reads that internal URL while Node performs the authenticated upstream request. API responses and logs never expose the source URL, secret reference, token, internal path, or FFmpeg arguments. Structured request logging redacts playback and internal source grants from URL paths.

Quest-facing playback requires a publicly trusted HTTPS certificate. Compose includes an optional Caddy ACME mode; manual-certificate and external reverse-proxy modes are also supported. The relay and agent WebSocket must receive the correct proxy headers and WebSocket upgrade handling, and internal source routes must never be exposed separately.
