#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu

cd "$(dirname "$0")/.."

version="${1:-0.0.0-container-smoke}"
image="vrrelay:container-smoke-$$"
container="vrrelay-container-smoke-$$"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
  docker image rm --force "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker info >/dev/null
docker build \
  --build-arg "VRRELAY_VERSION=$version" \
  --file deploy/docker/Dockerfile \
  --tag "$image" \
  .

actual_label="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' "$image")"
[ "$actual_label" = "$version" ] || {
  echo "Container version label is $actual_label, expected $version" >&2
  exit 1
}

docker run --rm --entrypoint sh "$image" -ec '
  test "$(id -u)" != 0
  node --version | grep -F "v26.5.0"
  ffmpeg -hide_banner -version | head -1 | grep -F "8.1.2"
  ffmpeg -hide_banner -encoders 2>/dev/null | grep -F "libx264"
  ffmpeg -hide_banner -filters 2>/dev/null | grep -F "subtitles"
'

docker run --detach \
  --name "$container" \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700 \
  --tmpfs /data:rw,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700 \
  --tmpfs /cache:rw,nosuid,nodev,size=128m,uid=1000,gid=1000,mode=0700 \
  --env VRRELAY_MASTER_KEY='container-smoke-master-key-000000000' \
  --env VRRELAY_SECRET_BACKEND=encrypted-file \
  --env VRRELAY_PUBLIC_URL=http://127.0.0.1:8099 \
  "$image" >/dev/null

ready=false
for _attempt in $(seq 1 60); do
  if docker exec "$container" node -e \
    "fetch('http://127.0.0.1:8099/api/v1/health').then(async response=>{if(!response.ok)process.exit(1);const body=await response.json();if(body.version!=='$version')process.exit(1)}).catch(()=>process.exit(1))"; then
    ready=true
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$container")" != true ]; then
    docker logs "$container" >&2
    echo 'VRRelay container stopped before becoming healthy' >&2
    exit 1
  fi
  sleep 1
done

if [ "$ready" != true ]; then
  docker logs "$container" >&2
  echo 'VRRelay container did not become healthy within 60 seconds' >&2
  exit 1
fi

echo "Container smoke test passed for VRRelay $version."
