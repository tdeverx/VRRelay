# Deployment

## Local macOS development

```sh
npm ci
npm run build
VRRELAY_LISTEN_ADDR=127.0.0.1:8099 node apps/relay/dist/main.js
```

The SwiftPM menu-bar host builds with `swift build --package-path apps/macos`. The `.pkg` installs the `org.vrrelay.service` system LaunchDaemon, which supervises both the TypeScript relay and bundled MediaMTX process, so closing the menu application or logging out does not stop active streams. Start, stop, and restart actions request administrator approval and target that installed service; the separate “Open menu controller at login” setting uses the native macOS login-item service. Upgrades retain service data; the uninstall script removes binaries and retains data unless `--purge-data` is explicit.

Release packaging requires the Homebrew `ffmpeg@7` executable through `VRRELAY_FFMPEG_BINARY`. The packager verifies version 7.1.5, copies every non-system dynamic library, rewrites loader paths to the package, signs the finalized runtime, and writes `runtime-provenance.json` containing the exact bundled hashes. It does not silently fall back to another FFmpeg on `PATH`.

## Docker Compose

Set random values for `VRRELAY_MASTER_KEY` and `VRRELAY_MEDIAMTX_READ_TOKEN`, set public HTTP/RTMP/SRT/WHIP URLs, then run:

```sh
docker compose -f deploy/docker/docker-compose.yml up --build
```

Use `compose.gpu.yml` as a host-specific example for `/dev/dri` or NVIDIA access. Hardware presets stay disabled unless FFmpeg discovers the relevant encoder.

The OCI image does not install the host distribution's moving FFmpeg package. Its x64 and arm64 builds download the architecture-specific FFmpeg 7.1.5 GPL artifact recorded in `deploy/runtime-manifest.json`, verify SHA-256 before extraction, and self-test version, `libx264`, and subtitle-filter availability during the image build.

MediaMTX authenticates publishers and readers through VRRelay's internal callback. RTMP, SRT, and WHIP are ingest methods; standard HLS is the initial live playback output.

## Distributed Compose

Copy the secret variables from `.env.example`, provide controller and edge HTTPS URLs, then run:

```sh
docker compose -f deploy/docker/docker-compose.cluster.yml up --build
```

This topology bundles PostgreSQL, Valkey, MinIO, and separate controller, source-worker, ingest-origin, and edge services. For different machines, use `compose.multi-host.yml` with exactly one role profile per host and external database, coordination, and object-store endpoints. Enroll every non-controller node with a single-use token, then remove that token from its environment. Set `VRRELAY_LIVE_ORIGIN_URL` on every edge to the ingest origin's reachable SRT URL (preferred across regions) or RTSP URL. When SRT crosses an untrusted network, set the same 10–79 character `VRRELAY_LIVE_SRT_PASSPHRASE` on the origin and its edges; keep it in the platform secret environment instead of embedding it in the origin URL. WHIP additionally requires trusted HTTPS signaling, the advertised public/LAN host in `VRRELAY_WEBRTC_ADDITIONAL_HOSTS`, and UDP 8189 forwarded to the MediaMTX origin; the TLS Compose overlay includes a dedicated WHIP reverse proxy domain. The edge relay creates the MediaMTX path through its private Control API on first playback; MediaMTX then pulls that path on demand and fans it out locally, producing one origin-to-edge stream rather than one upstream per viewer. Do not expose the edge Control API or its internal HLS port publicly.

## Kubernetes and generic VMs

`deploy/kubernetes` is a provider-neutral Helm chart with all four role workloads, persistent storage, probes, service accounts, network policy, TLS ingress, GPU resource overrides, and upgrade migration hooks. It accepts externally managed PostgreSQL, Valkey, and object-store endpoints. The controller remains one replica for v1. Live ingest runs through the authenticated `vrrelay-mediamtx-origin` workload; every edge pod contains a private MediaMTX sidecar and creates an on-demand SRT pull from that origin. Set `mediaMtx.ingestService.type` to `LoadBalancer` (and provider-neutral service annotations as required) when OBS must reach the Kubernetes origin from outside the cluster. Expose `controller.agentService` only through raw TCP/TLS passthrough, and use `edge.ingress` for the public edge URL. The origin Control API/HLS service and all edge sidecars remain cluster-private. Kubernetes installation is staged because every role consumes a distinct single-use token; see the chart's `README.md`.

## Windows

The Windows package registers the TypeScript relay with WinSW as an automatic service. That relay supervises the bundled MediaMTX process, and WinSW restarts the complete stack if either process fails. The Electron tray uses Windows Service Control Manager and may be closed independently. Release packaging supplies validated Node, FFmpeg (AMF/QSV/NVENC capable), MediaMTX, and WinSW binaries.

The Windows packager downloads the immutable FFmpeg 7.1.5 BtbN GPL archive and Electron 39.8.10 directly from the URLs represented in the runtime manifest, verifies both archive hashes before extraction, signs all bundled executables when credentials are available, and records their finalized hashes in `runtime-provenance.json` before building the installer.

## TLS modes

- For built-in ACME, set `VRRELAY_DOMAIN` and `ACME_EMAIL`, then add `-f deploy/docker/compose.tls.yml` to the Compose command. The bundled Caddy service obtains and renews the certificate.
- For manual certificates, terminate TLS in Caddy, nginx, or another local reverse proxy and mount its certificate/key through that proxy's configuration.
- For an existing reverse proxy, publish the relay only to the private Docker network or loopback and proxy both ordinary HTTP and WebSocket upgrades to port 8099.

Quest-facing playback must use a trusted HTTPS certificate. The relay's internal Jellyfin source route is loopback-only and must never be exposed or rewritten by a reverse proxy.
