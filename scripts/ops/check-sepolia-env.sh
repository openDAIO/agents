#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${ENV_FILE:-.env}"
AGENT_ENV_PREFIX="${AGENT_ENV_PREFIX:-.env.agent_}"
DEPLOYMENT_SNAPSHOT="${DEPLOYMENT_SNAPSHOT:-.deployments/sepolia.json}"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

info() {
  printf '[check] %s\n' "$*"
}

env_value() {
  local file="$1"
  local key="$2"
  { grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null || true; } \
    | tail -n 1 \
    | sed -E "s/^[[:space:]]*${key}=//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^\"(.*)\"$/\\1/; s/^'(.*)'$/\\1/"
}

require_file() {
  local file="$1"
  [ -f "$file" ] || die "missing required file: $file"
}

require_env() {
  local file="$1"
  local key="$2"
  local value
  value="$(env_value "$file" "$key")"
  [ -n "$value" ] || die "$file must set $key"
}

optional_env() {
  local file="$1"
  local key="$2"
  env_value "$file" "$key"
}

is_hex32() {
  [[ "$1" =~ ^(0x)?[0-9a-fA-F]{64}$ ]]
}

is_bool() {
  [[ "$1" =~ ^(true|false|1|0|yes|no|on|off)$ ]]
}

require_hex32() {
  local file="$1"
  local key="$2"
  local value
  value="$(env_value "$file" "$key")"
  [ -n "$value" ] || die "$file must set $key"
  is_hex32 "$value" || die "$file $key must be a 32-byte hex value"
}

require_http_url() {
  local file="$1"
  local key="$2"
  local value
  value="$(env_value "$file" "$key")"
  [ -n "$value" ] || die "$file must set $key"
  [[ "$value" =~ ^https?:// ]] || die "$file $key must start with http:// or https://"
}

require_bool_env() {
  local file="$1"
  local key="$2"
  local expected="${3:-}"
  local value
  value="$(env_value "$file" "$key")"
  [ -n "$value" ] || die "$file must set $key"
  is_bool "$value" || die "$file $key must be boolean-like"
  if [ -n "$expected" ] && [ "$value" != "$expected" ]; then
    die "$file $key must be $expected for Sepolia production serving"
  fi
}

require_file "$ENV_FILE"
require_file "$DEPLOYMENT_SNAPSHOT"
grep -q '"chainId"[[:space:]]*:[[:space:]]*11155111' "$DEPLOYMENT_SNAPSHOT" \
  || die "$DEPLOYMENT_SNAPSHOT is not a Sepolia deployment snapshot"

require_http_url "$ENV_FILE" "RPC_URL"
require_env "$ENV_FILE" "DAIO_DEPLOYMENT_FILE"
require_bool_env "$ENV_FILE" "CONTENT_REQUIRE_AGENT_SIGNATURES" "true"

if [ -z "$(optional_env "$ENV_FILE" "RPC_URLS")" ]; then
  warn "$ENV_FILE RPC_URLS is empty; use at least two Sepolia RPC endpoints for production"
fi

if [ "${REQUIRE_CONTENT_RELAYER:-true}" = "true" ]; then
  require_hex32 "$ENV_FILE" "CONTENT_RELAYER_PRIVATE_KEY"
else
  if [ -z "$(optional_env "$ENV_FILE" "CONTENT_RELAYER_PRIVATE_KEY")" ]; then
    warn "CONTENT_RELAYER_PRIVATE_KEY is empty; relayed request API will not send transactions"
  fi
fi

case "$(optional_env "$ENV_FILE" "CONTENT_SERVICE_BIND")" in
  0.0.0.0) warn "content-service is bound to 0.0.0.0; restrict the EC2 security group or put it behind auth/TLS" ;;
  "") warn "$ENV_FILE CONTENT_SERVICE_BIND is empty; docker compose will bind content-service to 127.0.0.1" ;;
esac

case "$(optional_env "$ENV_FILE" "MARKITDOWN_BIND")" in
  0.0.0.0) warn "MarkItDown is bound to 0.0.0.0; expose it only to trusted callers" ;;
  "") warn "$ENV_FILE MARKITDOWN_BIND is empty; docker compose will bind MarkItDown to 127.0.0.1" ;;
esac

for i in 1 2 3 4 5; do
  file="${AGENT_ENV_PREFIX}${i}"
  require_file "$file"
  require_http_url "$file" "RPC_URL"
  require_http_url "$file" "LLM_BASE_URL"
  require_env "$file" "LLM_MODEL"
  require_hex32 "$file" "AGENT_PRIVATE_KEY"
  require_hex32 "$file" "AGENT_VRF_PRIVATE_KEY"
  require_hex32 "$file" "AGENT_STATE_KEY"
  require_bool_env "$file" "DAIO_AUTO_START_REQUESTS" "true"
  require_bool_env "$file" "DAIO_ALLOW_FIXTURE_VRF" "false"

  auto_register="$(optional_env "$file" "AGENT_AUTO_REGISTER")"
  if [ -n "$auto_register" ]; then
    is_bool "$auto_register" || die "$file AGENT_AUTO_REGISTER must be boolean-like"
  fi
  if [[ "$auto_register" =~ ^(true|1|yes|on)$ ]]; then
    require_env "$file" "AGENT_ID"
    require_env "$file" "AGENT_ENS_NAME"
  fi

  tx_key="$(optional_env "$file" "AGENT_PRIVATE_KEY")"
  vrf_key="$(optional_env "$file" "AGENT_VRF_PRIVATE_KEY")"
  state_key="$(optional_env "$file" "AGENT_STATE_KEY")"
  if [ "$tx_key" = "$vrf_key" ] || [ "$tx_key" = "$state_key" ] || [ "$vrf_key" = "$state_key" ]; then
    warn "$file reuses a transaction, VRF, or state key; use distinct secrets for production"
  fi
done

info "Sepolia serving env files look complete"
