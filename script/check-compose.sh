#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
set -eu

cd "$(dirname "$0")/.."

# Compose requires these deterministic fixture values during interpolation.
# They render the production-mode manifests without using real deployment
# credentials or contacting external services.
export VRRELAY_MASTER_KEY='compose-check-master-key-000000000000'
export VRRELAY_MEDIAMTX_READ_TOKEN='compose-check-read-token-00000000000'
export POSTGRES_PASSWORD='compose-check-postgres'
export MINIO_ROOT_USER='compose-check-root'
export MINIO_ROOT_PASSWORD='compose-check-root-password'
export MINIO_CONTROLLER_USER='compose-check-controller'
export MINIO_CONTROLLER_PASSWORD='compose-check-controller-password'
export MINIO_SOURCE_USER='compose-check-source'
export MINIO_SOURCE_PASSWORD='compose-check-source-password'
export MINIO_EDGE_USER='compose-check-edge'
export MINIO_EDGE_PASSWORD='compose-check-edge-password'
export MINIO_INGEST_USER='compose-check-ingest'
export MINIO_INGEST_PASSWORD='compose-check-ingest-password'
export VRRELAY_ENVIRONMENT='production'
export VRRELAY_TRUSTED_PROXY_CIDRS='10.20.0.0/16'
export VRRELAY_PUBLIC_URL='https://relay.example.test'
export VRRELAY_CONTROLLER_ENROLLMENT_URL='https://relay.example.test'
export VRRELAY_CONTROLLER_AGENT_URL='wss://relay.example.test:8100/api/v1/nodes/connect'
export VRRELAY_EDGE_PUBLIC_URL='https://edge.example.test'
export VRRELAY_SETUP_TOKEN='compose-check-setup-token-000000000'
export VRRELAY_AGENT_TLS_NAMES='relay.example.test,controller'
export VRRELAY_POSTGRES_URL='postgres://vrrelay:compose-check-postgres@postgres.example.test:5432/vrrelay'
export VRRELAY_VALKEY_URL='redis://valkey.example.test:6379'
export VRRELAY_OBJECT_STORE_DRIVER='s3'
export VRRELAY_OBJECT_STORE_BUCKET='vrrelay'
export VRRELAY_LIVE_ORIGIN_URL='srt://ingest.example.test:8890'
export VRRELAY_RTMP_URL='rtmp://ingest.example.test/live'
export VRRELAY_SRT_URL='srt://ingest.example.test:8890'
export VRRELAY_WHIP_URL='https://ingest.example.test'
export VRRELAY_IMAGE='ghcr.io/example/vrrelay:compose-check'
export VRRELAY_DOMAIN='relay.example.test'
export VRRELAY_INGEST_DOMAIN='ingest.example.test'
export ACME_EMAIL='admin@example.test'

docker compose -f deploy/docker/docker-compose.yml config --quiet
docker compose \
  -f deploy/docker/docker-compose.yml \
  -f deploy/docker/compose.tls.yml \
  config --quiet
docker compose \
  -f deploy/docker/docker-compose.yml \
  -f deploy/docker/compose.gpu.yml \
  config --quiet
docker compose -f deploy/docker/docker-compose.cluster.yml config --quiet

for profile in controller source-worker ingest-origin edge; do
  docker compose \
    -f deploy/docker/compose.multi-host.yml \
    --profile "$profile" \
    config --quiet
done
node script/check-compose-semantics.mjs

echo 'Compose deployment checks passed.'
