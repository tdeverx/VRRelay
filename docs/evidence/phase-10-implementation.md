# Phase 10 implementation checkpoint — multi-host Compose semantics

Date: 2026-07-15

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

## Lean guardrails run

Commands:

```text
npm run check:compose
npm run check:kubernetes
npm run check:cloud-init
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
post-enrollment join-token cleanup. The local full CI gate passed 373 tests with
23 intentional skips and reported zero npm vulnerabilities.

## Deferred to later Phase 10 and final high-pass verification

- True multi-host-equivalent boot evidence with separate hosts or separate
  network namespaces.
- Rendered Helm, Kubernetes TLS, network-policy, upgrade, and recovery evidence.
- Backup/restore rehearsal, true cloud-VM boot evidence, release OCI digest
  selection, GPU-path deployment evidence, and rollback evidence.
