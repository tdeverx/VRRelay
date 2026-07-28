#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT

cd "$root"
script/check-workflows.sh
npm run check:kubernetes
npm run check:cloud-init
npm run check:backup
npm run check:tls
npm run check:native-packaging
helm lint deploy/kubernetes
helm template vrrelay deploy/kubernetes > "$temporary/rendered.yaml"
node script/check-kubernetes.mjs "$temporary/rendered.yaml"
if helm template vrrelay deploy/kubernetes --set edge.replicas=2 > /dev/null; then
  echo 'Shared node identities must be rejected by the Helm chart' >&2
  exit 1
fi
helm template vrrelay deploy/kubernetes \
  --set sourceWorker.enabled=false \
  --set ingestOrigin.enabled=false \
  --set edge.enabled=false > "$temporary/controller-only.yaml"
if grep -q vrrelay-mediamtx-origin "$temporary/controller-only.yaml"; then
  echo 'Controller-only Helm topology must not start a MediaMTX origin' >&2
  exit 1
fi
tofu fmt -check -recursive deploy/opentofu
