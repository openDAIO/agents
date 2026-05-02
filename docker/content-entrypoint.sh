#!/usr/bin/env sh
set -eu

. /app/docker/materialize-deployment.sh

: "${RPC_URL:?RPC_URL is required}"

export CONTENT_SERVICE_HOST="${CONTENT_SERVICE_HOST:-0.0.0.0}"
export CONTENT_SERVICE_PORT="${CONTENT_SERVICE_PORT:-18002}"
export CONTENT_DB_PATH="${CONTENT_DB_PATH:-/app/data/content.sqlite}"
export CONTENT_DEPLOYMENT_PATH="${CONTENT_DEPLOYMENT_PATH:-$DAIO_DEPLOYMENT_PATH}"
export CONTENT_CHAIN_RPC_URL="${CONTENT_CHAIN_RPC_URL:-$RPC_URL}"
if [ -z "${CONTENT_CHAIN_RPC_URLS:-}" ] && [ -n "${RPC_URLS:-}" ]; then
  export CONTENT_CHAIN_RPC_URLS="$RPC_URLS"
fi

exec npm run content-service
