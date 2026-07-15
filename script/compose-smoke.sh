#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu

cd "$(dirname "$0")/.."

project="vrrelay-standalone-smoke-$$"
compose_file='deploy/docker/docker-compose.yml'
relay_container="${project}-relay-1"
mediamtx_container="${project}-mediamtx-1"
image="${project}-relay:latest"

export VRRELAY_MASTER_KEY='standalone-smoke-master-key-000000000'
export VRRELAY_MEDIAMTX_READ_TOKEN='standalone-smoke-read-token-000000000'
export VRRELAY_SETUP_TOKEN='standalone-smoke-setup-token-000000000'
export VRRELAY_PUBLIC_URL='http://127.0.0.1:8099'

cleanup() {
  docker compose --project-name "$project" -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker image rm --force "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if docker ps --format '{{.Ports}}' | grep -Eq '(^|,)0\.0\.0\.0:8099->|(^|,)\[::\]:8099->'; then
  echo 'Port 8099 is already in use by another Docker container' >&2
  exit 1
fi

docker compose --project-name "$project" -f "$compose_file" up --detach --build

ready=false
attempt=1
while [ "$attempt" -le 90 ]; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$relay_container" 2>/dev/null || true)"
  if [ "$health" = healthy ]; then
    ready=true
    break
  fi
  if [ "$health" = exited ] || [ "$health" = dead ]; then
    docker compose --project-name "$project" -f "$compose_file" logs --no-color >&2
    exit 1
  fi
  sleep 1
  attempt=$((attempt + 1))
done

if [ "$ready" != true ]; then
  docker compose --project-name "$project" -f "$compose_file" logs --no-color >&2
  echo 'VRRelay standalone Compose service did not become healthy' >&2
  exit 1
fi

attempt=1
while [ "$attempt" -le 60 ]; do
  state="$(docker inspect --format '{{.State.Status}}' "$mediamtx_container" 2>/dev/null || true)"
  [ "$state" = running ] && break
  sleep 1
  attempt=$((attempt + 1))
done
[ "${state:-}" = running ] || {
  docker compose --project-name "$project" -f "$compose_file" logs --no-color >&2
  echo 'MediaMTX did not start' >&2
  exit 1
}

curl --fail --silent --show-error http://127.0.0.1:8099/api/v1/health >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8099/ >/dev/null

docker exec "$relay_container" node --input-type=module -e "
  import { connect } from 'node:net';
  const response = await fetch('http://mediamtx:9997/v3/config/global/get');
  if (!response.ok) throw new Error('MediaMTX API returned ' + response.status);
  const config = await response.json();
  if (config.hlsVariant !== 'mpegts') throw new Error('Expected MPEG-TS HLS');
  await new Promise((resolve, reject) => {
    const socket = connect(1935, 'mediamtx');
    socket.setTimeout(5000);
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('RTMP listener timed out')); });
    socket.once('error', reject);
  });
"

echo 'Standalone Compose smoke test passed.'
