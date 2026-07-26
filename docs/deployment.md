# Deployment

## Local macOS development

```sh
npm ci
npm run build
VRRELAY_LISTEN_ADDR=127.0.0.1:8099 node apps/relay/dist/main.js
```

The SwiftPM menu-bar controller builds with `swift build --package-path apps/macos`. It is a
menu-bar-only utility with no Dock icon, application window, embedded browser, or settings window.
The macOS artifact is a drag-to-Applications DMG containing the app and an Applications shortcut.
After copying `VRRelay.app` to Applications, open it. No administrator approval is required: the
app copies its sealed runtime to `~/Library/Application Support/VRRelay`, installs
`org.vrrelay.service` as a per-user LaunchAgent, and starts it. The app also registers itself as a
login item when launched from Applications. **Restart relay** applies the runtime bundled with the
current app before restarting; **Stop relay** leaves the runtime and retained data installed. The
menu opens the dashboard in the system browser. **Quit VRRelay** waits for the LaunchAgent to stop
before exiting, so an intentional menu-app quit also ends active streams.

The LaunchAgent supervises both the TypeScript relay and bundled MediaMTX process independently of
the menu utility and starts at each login. A signal-forwarding runner keeps `service.log` plus eight
10 MiB historical files. Dashboard-requested restarts use a dedicated nonzero exit status so both
launchd and the Windows service supervisor relaunch the service. Logging out ends the current
user's relay processes; logging back in starts them again. Upgrades retain service data. Run
`deploy/macos/uninstall.sh`
from a trusted checkout to unload the user service and remove its installed runtime while retaining
data; pass `--purge-data` only when the retained data should also be deleted.

Native installs also set `VRRELAY_RUNTIME_CONFIG` to a service-owned file in retained application
state
and enable supervised exit/restart. The authenticated **Network** and **Runtime** panels validate
and persist only the documented non-secret listener, URL, proxy,
capacity, cache, and node-label fields. Environment variables still take precedence, so Docker,
Kubernetes, and other orchestrated deployments are displayed as read-only instead of having their
declarative configuration silently overridden. A saved native configuration becomes active only
after the user selects **Restart relay**. Listener hosts may be `localhost`, a literal IPv4 or IPv6
interface address, or a wildcard. Native controllers map wildcard listeners to loopback and follow
an exact saved interface address when opening or checking the local dashboard. On Windows, the
non-secret runtime file lives under `%ProgramData%\VRRelay\config`; protected databases and service
data remain under the separately restricted data directory.

The default macOS packager builds FFmpeg 8.1.2 from the structured,
checksum-pinned Apple Silicon recipe in `deploy/runtime-manifest.json`; it no
longer packages Homebrew's FFmpeg dependency graph. Install the recipe's build
tools and exercise the builder directly with:

```sh
brew install autoconf automake libtool meson ninja pkg-config
deploy/macos/build-ffmpeg.sh tmp/macos-ffmpeg
```

The builder targets arm64 and macOS 15, disables FFplay, FFprobe, autodetection,
and unnecessary device I/O, and links the eight recorded third-party inputs
statically. Only Apple system frameworks and `/usr/lib` libraries may remain
dynamic. It verifies the required encoders, filters, muxers, and protocols,
decodes a generated H.264/AAC MPEG-TS smoke output, and emits build metadata,
dependency licenses, and a complete source archive with per-file SHA-256 sums.
`VRRELAY_FFMPEG_BINARY` remains a development-only package override; release
mode rejects it and always uses the source recipe.

The packager signs nested runtime binaries with the hardened runtime and a
trusted timestamp when a Developer ID identity is present, signs the finalized
app, creates the DMG, and writes `runtime-provenance.json` with the exact bundled
hashes. Set `VRRELAY_RELEASE_PACKAGING=1` for release builds; that mode requires
Developer ID application signing and notarization credentials before the DMG
can be produced. The DMG is submitted, stapled, and assessed as the distributable
artifact. The attached
source archive and FriBidi license/source obligations must remain with the
distributed macOS FFmpeg binary.

## Docker Compose

Set random values for `VRRELAY_MASTER_KEY` and `VRRELAY_MEDIAMTX_READ_TOKEN`, set public HTTP/RTMP/SRT/WHIP URLs, and optionally set `VRRELAY_MEDIAMTX_IMAGE` to a digest-pinned MediaMTX image for release deployments, then run:

```sh
docker compose -f deploy/docker/docker-compose.yml up --build
```

Use `compose.gpu.yml` as a host-specific example for `/dev/dri` or NVIDIA access. Hardware presets stay disabled unless FFmpeg discovers the relevant encoder. When using the TLS overlay, set `VRRELAY_CADDY_IMAGE` to a digest-pinned Caddy image and keep the controller agent port on raw TCP/TLS passthrough rather than behind the HTTP proxy.

The standalone host ports remain 8099 (HTTP), 1935 (RTMP), 8889 (WHIP), 8189/UDP (WebRTC), and 8890/UDP (SRT). The administration port binds to `127.0.0.1` by default so an unconfigured instance cannot be claimed from the LAN. Set `VRRELAY_HTTP_HOST=0.0.0.0` only after configuring canonical HTTPS administration and playback URLs plus a random first-run setup token. Override the port numbers with `VRRELAY_HTTP_PORT`, `VRRELAY_RTMP_PORT`, `VRRELAY_WHIP_PORT`, `VRRELAY_WEBRTC_UDP_PORT`, and `VRRELAY_SRT_PORT` when running parallel stacks or avoiding a host-port conflict.

The OCI image does not install the host distribution's moving FFmpeg package. Its x64 and arm64 builds download the architecture-specific FFmpeg 8.1.2 GPL artifact recorded in `deploy/runtime-manifest.json`, verify SHA-256 before extraction, and self-test version, `libx264`, and subtitle-filter availability during the image build.

MediaMTX authenticates publishers and readers through VRRelay's internal callback. RTMP, SRT, and WHIP are ingest methods; standard HLS is the initial live playback output.

## Distributed Compose

Copy the secret variables from `.env.example`, provide controller and edge HTTPS
URLs, set `VRRELAY_CONTROLLER_ENROLLMENT_URL` to the controller's externally
trusted HTTPS origin, and set `VRRELAY_TRUSTED_PROXY_CIDRS` to only the actual
TLS proxy source ranges. The cluster manifest defaults to
`VRRELAY_ENVIRONMENT=production` and fails closed when those transport settings
or production secrets are unsafe. Configure the proxy to send one
`X-VRRelay-Region` value matching the target node labels, or change the header name with
`VRRELAY_VIEWER_REGION_HEADER`. `VRRELAY_VOD_PRODUCER_IDLE_TIMEOUT` defaults to `60s` and accepts
15 seconds through 10 minutes. `VRRELAY_VOD_PRODUCER_BUFFER_LOW_WATERMARK` and
`VRRELAY_VOD_PRODUCER_BUFFER_HIGH_WATERMARK` default to `30s` and `60s`; the high watermark must be
greater than the low watermark. The producer catches up below the low watermark and backpressures
its existing source connection at the high watermark. `VRRELAY_LOG_LEVEL=info` is the normal setting; use `debug` only
while collecting detailed redacted playback traces. Advanced deployments may also set the standard
Pino levels `trace`, `warn`, `error`, `fatal`, or `silent` through the environment; the dashboard
intentionally exposes only Normal and Detailed. `VRRELAY_VOD_PRODUCER_MAX_CONCURRENT` and
`VRRELAY_VOD_PRODUCER_MAX_PER_PROVIDER` default to `2` and bound source-worker producer admission
(the effective limit also cannot exceed `VRRELAY_MAX_WORKERS`). Session diagnostics expose the active
upstream source connection count and source request attempts over the last 30 seconds so operators
can distinguish provider pressure from edge delivery pressure. Distant producer replacements are
not rate-limited, so legitimate seeks are not artificially delayed. Then run:

```sh
docker compose -f deploy/docker/docker-compose.cluster.yml up --build
```

This topology bundles PostgreSQL, Valkey, MinIO, and separate controller, source-worker, ingest-origin, and edge services. For different machines, use `compose.multi-host.yml` with exactly one role profile per host and external database, coordination, and object-store endpoints. The multi-host file defines each role explicitly rather than inheriting the controller service, so source workers publish no ports, ingest origins publish only MediaMTX ingest ports, and edges publish only the relay playback port. Set digest-pinned `VRRELAY_IMAGE` and `VRRELAY_MEDIAMTX_IMAGE` values for multi-host release deployments. Enroll every non-controller node with a single-use token, then remove that token from its environment. Set `VRRELAY_LIVE_ORIGIN_URL` on every edge to the ingest origin's reachable SRT URL (preferred across regions) or RTSP URL. When SRT crosses an untrusted network, set the same 10–79 character `VRRELAY_LIVE_SRT_PASSPHRASE` on the origin and its edges; keep it in the platform secret environment instead of embedding it in the origin URL. WHIP additionally requires trusted HTTPS signaling, the advertised public/LAN host in `VRRELAY_WEBRTC_ADDITIONAL_HOSTS`, and UDP 8189 forwarded to the MediaMTX origin; the TLS Compose overlay includes a dedicated WHIP reverse proxy domain and blocks MediaMTX control/API paths at the public front door. The edge relay creates the MediaMTX path through its private Control API on first playback; MediaMTX then pulls that path on demand and fans it out locally, producing one origin-to-edge stream rather than one upstream per viewer. Do not expose the edge Control API or its internal HLS port publicly.

PostgreSQL 18 stores its versioned data directory below `/var/lib/postgresql`. Upgrade an existing PostgreSQL 17 cluster with `pg_upgrade` or a dump/restore before starting the refreshed Compose stack; do not attach the old PostgreSQL 17 volume directly to the PostgreSQL 18 service.

The clustered topology accepts the same media-port overrides plus `VRRELAY_CONTROLLER_HTTP_PORT`, `VRRELAY_CONTROLLER_AGENT_PORT`, and `VRRELAY_EDGE_HTTP_PORT`; their defaults remain 8099, 8101, and 8100 respectively.

Roll this schema/protocol change out as a coordinated cluster upgrade: stop all roles, start the
matching controller to apply schema v9, then restart every source worker and edge on the same
version. Old source workers do not advertise `vodProducerVersion: 1` and are excluded from HLS
placement.

## Kubernetes and generic VMs

`deploy/kubernetes` is a provider-neutral Helm chart with all four role workloads, persistent storage, probes, service accounts, network policy, TLS ingress, GPU resource overrides, and upgrade migration hooks. It accepts externally managed PostgreSQL, Valkey, and object-store endpoints. The migration hook uses the controller Secret, forces PostgreSQL repository mode, mounts writable data/tmp storage for schema checks and migration-backup artifacts, and has a bounded active deadline. The controller remains one replica for v1. Live ingest runs through the authenticated `vrrelay-mediamtx-origin` workload; every edge pod contains a private MediaMTX sidecar and creates an on-demand SRT pull from that origin. The chart renders both relay and MediaMTX workloads by digest when `image.digest` and `mediaMtx.image.digest` are set. Set `mediaMtx.ingestService.type` to `LoadBalancer` (and provider-neutral service annotations as required) when OBS must reach the Kubernetes origin from outside the cluster. Expose `controller.agentService` only through raw TCP/TLS passthrough, and use `edge.ingress` for the public edge URL. The origin Control API/HLS service and all edge sidecars remain cluster-private. Kubernetes installation is staged because every role consumes a distinct single-use token; set `rollout.runtimeSecretChecksum` when externally managed Secrets change and tighten `networkPolicy.externalEgress` to your runtime CIDRs before release. See the chart's `README.md`.

For generic VMs, `deploy/opentofu` creates no cloud resources. It renders one sensitive cloud-init document per supplied controller, source-worker, ingest-origin, or edge VM. The renderer requires digest-pinned VRRelay and MediaMTX image references, configures externally managed PostgreSQL/Valkey/object storage, mounts persistent host data/cache directories, includes the MediaMTX origin or edge sidecar only for roles that need it, and installs a timer that removes `VRRELAY_NODE_JOIN_TOKEN` after the node identity is persisted. Retain the non-secret `cloud_init_sha256` output with deployment evidence instead of logging user data.

## Windows

The Windows package registers the TypeScript relay with WinSW as an automatic service. That relay
supervises the bundled MediaMTX process, and WinSW restarts the complete stack if either process
fails. The native tray controller opens the dashboard in the system browser and exposes start,
stop, restart, and quit through Windows Service Control Manager. Quit waits for the service to stop
and remains open if that operation fails. Release packaging supplies validated Node, FFmpeg
(AMF/QSV/NVENC capable), MediaMTX, and WinSW binaries.

The Windows tray is a dependency-free Win32 C++ executable. It starts for the installing user at sign-in, opens the dashboard in the system browser, and requests UAC elevation only for service start, stop, restart, or quit. The Windows packager builds it from checked-in source with the statically linked MSVC runtime, downloads the immutable FFmpeg 8.1.2 BtbN GPL archive represented in the runtime manifest, verifies runtime hashes before extraction, signs all bundled executables when credentials are available, and records finalized third-party runtime hashes in `runtime-provenance.json` before building the installer. Set `VRRELAY_RELEASE_PACKAGING=1` for release builds; that mode requires the Windows signing certificate, signing password, and a verified FFmpeg corresponding-source bundle before the installer can be produced.

## TLS modes

- For built-in ACME, set `VRRELAY_DOMAIN` and `ACME_EMAIL`, then add `-f deploy/docker/compose.tls.yml` to the Compose command. The bundled Caddy service obtains and renews the certificate.
- For manual certificates, terminate TLS in Caddy, nginx, or another local reverse proxy and mount its certificate/key through that proxy's configuration.
- For an existing reverse proxy, publish the relay only to the private Docker network or loopback and proxy both ordinary HTTP and WebSocket upgrades to port 8099.

Quest-facing playback must use a trusted HTTPS certificate. The relay's internal Jellyfin source route is loopback-only and must never be exposed or rewritten by a reverse proxy.

### Dashboard-guided reverse-proxy setup

Native installations can configure their advertised URLs and trusted proxy CIDRs in **Network**.
Select **Nginx Proxy Manager**, enter the public hostname, and use
**Use for all URLs** to set the public, administration, and playback HTTPS origins together.
The page includes the required NPM front-door checklist and a command for finding its Docker
network subnet. Enter only the subnet or address NPM uses when it connects to VRRelay; never
trust a public catch-all range. Validate and save the configuration, then restart the relay.

The dashboard does not control DNS, router forwarding, Nginx Proxy Manager, or certificates.
Docker, Kubernetes, and other environment-managed deployments remain read-only; configure their
equivalent `VRRELAY_*` values in the deployment instead.
