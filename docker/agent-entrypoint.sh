#!/usr/bin/env sh
set -eu

. /app/docker/materialize-deployment.sh

: "${RPC_URL:?RPC_URL is required}"
: "${AGENT_PRIVATE_KEY:?AGENT_PRIVATE_KEY is required}"
: "${AGENT_STATE_KEY:?AGENT_STATE_KEY is required}"

CONTENT_SERVICE_URL="${CONTENT_SERVICE_URL:-http://content-service:18002}"
AGENT_LABEL="${AGENT_LABEL:-reviewer}"
AGENT_STATE_DIR="${AGENT_STATE_DIR:-/app/state/$AGENT_LABEL}"

set -- npm run agent -- \
  --rpc "$RPC_URL" \
  --content-svc "$CONTENT_SERVICE_URL" \
  --deployment "$DAIO_DEPLOYMENT_PATH" \
  --state-dir "$AGENT_STATE_DIR" \
  --label "$AGENT_LABEL"

if [ "${AGENT_AUTO_REGISTER:-false}" = "true" ] || [ "${AGENT_AUTO_REGISTER:-false}" = "1" ]; then
  : "${AGENT_ID:?AGENT_ID is required when AGENT_AUTO_REGISTER=true}"
  AGENT_ENS_NAME="${AGENT_ENS_NAME:-$AGENT_LABEL.daio.eth}"
  set -- "$@" --auto-register --agent-id "$AGENT_ID" --ens-name "$AGENT_ENS_NAME"
fi

exec "$@"
