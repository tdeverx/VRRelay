# Phase 10 implementation checkpoint — multi-host Compose semantics

Date: 2026-07-16

This is a build-first deployment checkpoint for Phase 10. It is not final
multi-host, Kubernetes, TLS, backup/restore, upgrade, rollback, cloud-VM, or
release-candidate deployment evidence.

## Scope completed

- `deploy/docker/compose.multi-host.yml` no longer uses Compose `extends`, so
  source-worker, ingest-origin, and edge profiles cannot inherit controller
  ports, controller-only listeners, or controller role environment.
- Each multi-host profile now renders explicit role services:
  - `controller`: controller relay only, publishing administration/playback and
    agent mTLS ports.
  - `source-worker`: source worker relay only, with no published ports.
  - `ingest-origin`: ingest relay plus the MediaMTX origin, publishing only OBS
    ingest/WHIP/SRT ports from MediaMTX.
  - `edge`: edge relay plus the private MediaMTX edge sidecar, publishing only
    the edge relay playback port.
- The multi-host topology now requires external PostgreSQL, Valkey, object-store,
  controller URL, and trusted-proxy environment instead of silently relying on
  single-host service names.
- `script/check-compose-semantics.mjs` verifies profile service sets, role
  environment, controller-agent listener isolation, and published-port ownership
  in addition to `docker compose config --quiet`.
- The Helm migration hook now runs with production controller settings,
  explicitly forces PostgreSQL repository mode, reads `VRRELAY_POSTGRES_URL`
  and trusted-proxy CIDRs from the controller Secret, and mounts writable
  `/var/lib/vrrelay` plus `/tmp` storage for schema checks and migration-backup
  artifacts.
- `script/check-kubernetes-templates.mjs` statically guards the migration hook
  and runtime templates so local checks catch accidental SQLite fallback even
  when Helm is unavailable.
- `deploy/opentofu` now renders provider-neutral, role-specific cloud-init for
  supplied VMs rather than only documenting that a provider module should exist.
  The module requires digest-pinned VRRelay and MediaMTX image refs, forces
  PostgreSQL/Valkey runtime mode, persists node data/cache, renders the required
  MediaMTX sidecars for ingest-origin and edge nodes, and emits non-secret
  `cloud_init_sha256` evidence hashes alongside sensitive user data.
- The rendered cloud-init installs a post-enrollment scrub timer that removes
  `VRRELAY_NODE_JOIN_TOKEN` from `/etc/vrrelay/node.env` after
  `cluster:node-identity` appears in the encrypted file secret store.
- `script/check-cloud-init.mjs` statically guards the OpenTofu/cloud-init
  contract without requiring provider credentials or an OpenTofu binary.
- `deploy/docker/backup.sh` and `deploy/docker/restore.sh` now cover both
  PostgreSQL and SQLite repositories. They create private atomic artifacts,
  validate schema metadata and archive integrity, emit checksum/metadata
  sidecars, support optional OpenSSL encryption, and make destructive restores
  take a rollback backup unless explicitly bypassed.
- `script/check-backup-restore.mjs` runs shell syntax checks and guards the
  backup/restore hardening contract in local CI.
- The TLS Compose overlay now requires a digest-pinned Caddy image and blocks
  relay `/internal/*`, metrics/debug paths, and MediaMTX `/v3/*` control paths
  at the public HTTP front doors. It still does not proxy the raw controller
  agent mTLS port.
- Compose deployment artifacts now accept digest-pinned operational images, and
  the multi-host profile requires digest-pinned VRRelay and MediaMTX images for
  release-style rendering. The Helm chart now supports
  `image.repository@image.digest` for relay workloads and
  `mediaMtx.image.repository@mediaMtx.image.digest` for MediaMTX workloads
  instead of only `repository:tag`.
- `script/check-tls-fronts.mjs`, `script/check-compose-semantics.mjs`, and
  `script/check-kubernetes-templates.mjs` guard those TLS and image-pinning
  assumptions locally.
- Kubernetes runtime policies now replace the previous unrestricted relay
  egress rule with explicit pod, DNS, external-CIDR, and WebRTC UDP egress
  blocks. The chart also exposes `rollout.runtimeSecretChecksum` for externally
  managed Secret-change rollouts and gives the migration hook an active
  deadline.
- Helm values quote both IPv4 and IPv6 CIDRs so Helm 4 parses the default policy
  correctly. Controller egress references the MediaMTX origin only when both
  MediaMTX and the ingest-origin workload are enabled, so a controller-only
  staged bootstrap does not retain a selector for a disabled origin.
- The OpenTofu module is formatted with OpenTofu 1.10.6 and validates without
  provider credentials.

## Lean guardrails run

Commands:

```text
npm run check:compose
npm run check:kubernetes
npm run check:cloud-init
npm run check:backup
npm run check:tls
.data/toolchain/helm-v4.2.3/helm lint deploy/kubernetes
.data/toolchain/helm-v4.2.3/helm template vrrelay deploy/kubernetes \
  --values deploy/kubernetes/values.yaml
.data/toolchain/tofu-v1.10.6/tofu -chdir=deploy/opentofu fmt -check
.data/toolchain/tofu-v1.10.6/tofu -chdir=deploy/opentofu validate
SQLite temp backup/restore rehearsal
SQLite encrypted temp backup/restore rehearsal
npm run ci
```

Result: the standalone, TLS, GPU overlay, single-host cluster, and all
multi-host role profiles rendered successfully. The semantic checker confirmed
that the multi-host source-worker has no published ports, ingest-origin only
publishes MediaMTX ingest ports, edge only publishes the relay playback port,
and no data-plane relay inherits `VRRELAY_AGENT_LISTEN_ADDR`. The Kubernetes
template checker confirmed that the migration hook cannot silently use SQLite
defaults and that runtime deployments continue to load role-scoped Secrets. The
cloud-init/OpenTofu checker confirmed role-specific VM user-data rendering,
persistent data/cache mounts, digest-pinned image inputs, MediaMTX sidecars, and
post-enrollment join-token cleanup. The backup/restore checker confirmed shell
syntax, PostgreSQL/SQLite coverage, artifact validation, checksum/metadata
sidecars, optional encryption, and rollback-backup enforcement. Local temporary
SQLite rehearsals restored schema versions from both plain and encrypted
artifacts and created rollback backup sidecars before restore. The TLS checker
confirmed separate relay/ingest front doors, internal/control path blocking, and
no HTTP proxy publication of the raw agent mTLS port. Compose semantic checks
confirmed multi-host digest-pinned relay/MediaMTX images, and Kubernetes
template checks confirmed digest-aware relay and MediaMTX image rendering. The
local full CI gate also confirmed explicit Kubernetes egress ipBlocks, runtime
Secret checksum rollout annotations, and the migration active deadline. It
passed 373 tests with 23 intentional skips and reported zero npm vulnerabilities.
Helm 4.2.3 linted one chart with zero failures and rendered the corrected
default topology. OpenTofu 1.10.6 reported that the formatted module
configuration is valid.

## Deferred to later Phase 10 and final high-pass verification

- True multi-host-equivalent boot evidence with separate hosts or separate
  network namespaces.
- Disposable-cluster Kubernetes TLS, network-policy enforcement, upgrade, and
  recovery evidence.
- Live PostgreSQL/object-store/cluster backup-restore rehearsal, true cloud-VM
  boot evidence, final release OCI digest selection, GPU-path deployment
  evidence, and rollback evidence.
