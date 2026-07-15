# Kubernetes deployment

The chart deploys one authoritative controller, one explicitly enrolled node for each enabled worker role, an authenticated MediaMTX ingest origin, and a private MediaMTX sidecar in the edge pod. Install another release in a separate namespace or cluster for each additional region. Automatic replica scaling is deliberately rejected in v1 because every node must consume its own single-use join token and retain a distinct mTLS identity.

## Prerequisites

- A PostgreSQL database, Valkey/Redis-compatible coordination service, and supported object store reachable from every role.
- A storage class that supports `ReadWriteOnce` claims.
- Trusted HTTPS for the controller and every public edge URL.
- TCP passthrough to the controller agent port when nodes connect over the public internet, or private routing to its `ClusterIP` service.
- A load balancer or equivalent UDP/TCP forwarding for OBS ingest when the publisher is outside the cluster.

The chart reads bootstrap/runtime values from four pre-existing Secrets:

- `vrrelay-controller-runtime`
- `vrrelay-source-worker-runtime`
- `vrrelay-ingest-origin-runtime`
- `vrrelay-edge-runtime`

All role Secrets contain `VRRELAY_POSTGRES_URL`, `VRRELAY_VALKEY_URL`, `VRRELAY_MASTER_KEY`, the selected object-store credentials, and the same random `VRRELAY_MEDIAMTX_READ_TOKEN`. The ingest-origin and edge Secrets also contain the same 10–79 character `VRRELAY_LIVE_SRT_PASSPHRASE`, which encrypts the origin-to-edge SRT transport. The controller Secret also contains the temporary `VRRELAY_SETUP_TOKEN`. Each non-controller Secret contains a different `VRRELAY_NODE_JOIN_TOKEN` issued for exactly that role. Use a different master key for every node.

Create Secrets from temporary files outside the repository; never place their values in a Helm values file or Git:

```bash
kubectl create namespace vrrelay
kubectl -n vrrelay create secret generic vrrelay-controller-runtime \
  --from-env-file=/secure/path/controller.env
```

## Staged installation

The controller must exist before it can issue single-use node tokens. Start with all agents disabled:

```bash
helm upgrade --install vrrelay ./deploy/kubernetes \
  --namespace vrrelay \
  --set sourceWorker.enabled=false \
  --set ingestOrigin.enabled=false \
  --set edge.enabled=false
```

Complete first-run setup, create one scoped join token for each role, and create the three role Secrets. Then enable the agents:

```bash
helm upgrade vrrelay ./deploy/kubernetes \
  --namespace vrrelay \
  --set sourceWorker.enabled=true \
  --set ingestOrigin.enabled=true \
  --set edge.enabled=true
```

After every agent has persisted its certificate on its own PVC, remove `VRRELAY_NODE_JOIN_TOKEN` from that role's Secret. A restarted pod reuses its encrypted identity and does not need another token.

The default PodDisruptionBudgets prevent voluntary eviction of the single v1 node in each role. Before planned node maintenance, drain the corresponding VRRelay node in the dashboard, temporarily set `disruptionBudget.enabled=false`, perform the Kubernetes eviction, and restore the budget after the replacement is online.

## Public endpoints

- The normal `ingress` values expose the controller API/dashboard and clean playback director URL.
- `edge.ingress` exposes the edge relay. Its host must match `edge.publicUrl` and remain HTTPS-only for VRChat/Quest.
- `controller.agentService` exposes port 8100. Use `LoadBalancer` only with raw TCP/TLS passthrough; do not terminate or replace VRRelay's node mTLS at an HTTP ingress.
- `mediaMtx.ingestService` exposes OBS RTMP, SRT, and the WebRTC ICE UDP socket. Set it to `LoadBalancer` when the publisher is outside the cluster, and make `mediaMtx.publicUrls.rtmp` / `srt` match its reachable address.
- `mediaMtx.whipIngress` terminates trusted HTTPS for WHIP signaling and forwards it to the internal origin. Its host must match `mediaMtx.publicUrls.whip`. Put the UDP load balancer's reachable IP or DNS name in `mediaMtx.webrtcAdditionalHosts`; WHIP signaling alone is insufficient without UDP 8189 reaching MediaMTX.

For a remote edge-only region, disable `controller`, `sourceWorker`, and `ingestOrigin`, set `edge.liveOriginUrl` to the home origin's overlay or public SRT address, and supply that edge's own runtime Secret and join token. Keep the SRT passphrase in the Secret, not in `liveOriginUrl`.

The MediaMTX Control API, origin HLS/RTSP service, and edge sidecar ports are not exposed publicly. The edge relay authorizes playback, configures its sidecar through localhost, and proxies the resulting HLS response.

## Verification

Before exposing the deployment, verify that every node is online in the topology view, bind Jellyfin only to the intended source worker, and run the checked-in placement and live-fan-out scenarios. Draining the edge must move refreshed playlists elsewhere; deleting and recreating an edge pod must preserve its node identity; one OBS publication must produce no more than one origin pull for that edge.
