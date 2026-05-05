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

unique_rpc_count() {
  local file="$1"
  {
    optional_env "$file" "RPC_URL"
    optional_env "$file" "RPC_URLS" | tr ',' '\n' | tr '[:space:]' '\n'
  } | sed '/^[[:space:]]*$/d' | sort -u | wc -l | tr -d ' '
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

require_llm_config() {
  local file="$1"
  local llm_base_url openai_key llm_model openai_model
  llm_base_url="$(optional_env "$file" "LLM_BASE_URL")"
  openai_key="$(optional_env "$file" "OPENAI_API_KEY")"
  llm_model="$(optional_env "$file" "LLM_MODEL")"
  openai_model="$(optional_env "$file" "OPENAI_MODEL")"

  if [ -n "$llm_base_url" ]; then
    require_http_url "$file" "LLM_BASE_URL"
  elif [ -z "$openai_key" ]; then
    die "$file must set LLM_BASE_URL or OPENAI_API_KEY"
  fi

  if [ -z "$llm_model" ] && [ -z "$openai_model" ]; then
    die "$file must set LLM_MODEL or OPENAI_MODEL"
  fi
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
if [ "$(unique_rpc_count "$ENV_FILE")" -lt 2 ]; then
  warn "$ENV_FILE should include at least two unique RPC endpoints across RPC_URL/RPC_URLS"
fi
if [ "$(optional_env "$ENV_FILE" "RPC_BATCH_MAX_COUNT")" != "1" ]; then
  warn "$ENV_FILE RPC_BATCH_MAX_COUNT=1 is recommended for public/free RPC providers"
fi

if [ "${REQUIRE_CONTENT_RELAYER:-true}" = "true" ]; then
  require_hex32 "$ENV_FILE" "CONTENT_RELAYER_PRIVATE_KEY"
else
  if [ -z "$(optional_env "$ENV_FILE" "CONTENT_RELAYER_PRIVATE_KEY")" ]; then
    warn "CONTENT_RELAYER_PRIVATE_KEY is empty; relayed request API will not send transactions"
  fi
fi

global_keeper_key="$(optional_env "$ENV_FILE" "DAIO_KEEPER_PRIVATE_KEY")"
if [ -n "$global_keeper_key" ] && ! is_hex32 "$global_keeper_key"; then
  die "$ENV_FILE DAIO_KEEPER_PRIVATE_KEY must be a 32-byte hex value"
fi

case "$(optional_env "$ENV_FILE" "CONTENT_SERVICE_BIND")" in
  0.0.0.0) warn "content-service is bound to 0.0.0.0; restrict the EC2 security group or put it behind auth/TLS" ;;
  "") warn "$ENV_FILE CONTENT_SERVICE_BIND is empty; docker compose will bind content-service to 127.0.0.1" ;;
esac

case "$(optional_env "$ENV_FILE" "MARKITDOWN_BIND")" in
  0.0.0.0) warn "MarkItDown is bound to 0.0.0.0; expose it only to trusted callers" ;;
  "") warn "$ENV_FILE MARKITDOWN_BIND is empty; docker compose will bind MarkItDown to 127.0.0.1" ;;
esac

keeper_count=0
for i in 1 2 3 4 5; do
  file="${AGENT_ENV_PREFIX}${i}"
  require_file "$file"
  require_http_url "$file" "RPC_URL"
  require_llm_config "$file"
  require_hex32 "$file" "AGENT_PRIVATE_KEY"
  require_hex32 "$file" "AGENT_VRF_PRIVATE_KEY"
  require_hex32 "$file" "AGENT_STATE_KEY"
  require_bool_env "$file" "DAIO_AUTO_START_REQUESTS" "true"
  require_bool_env "$file" "DAIO_ALLOW_FIXTURE_VRF" "false"
  tx_key="$(optional_env "$file" "AGENT_PRIVATE_KEY")"
  vrf_key="$(optional_env "$file" "AGENT_VRF_PRIVATE_KEY")"
  state_key="$(optional_env "$file" "AGENT_STATE_KEY")"
  keeper_key="$(optional_env "$file" "DAIO_KEEPER_PRIVATE_KEY")"
  if [ -n "$keeper_key" ] && ! is_hex32 "$keeper_key"; then
    die "$file DAIO_KEEPER_PRIVATE_KEY must be a 32-byte hex value"
  fi
  if [ "$(unique_rpc_count "$file")" -lt 2 ]; then
    warn "$file should include at least two unique RPC endpoints across RPC_URL/RPC_URLS"
  fi
  if [ "$(optional_env "$file" "RPC_BATCH_MAX_COUNT")" != "1" ]; then
    warn "$file RPC_BATCH_MAX_COUNT=1 is recommended for public/free RPC providers"
  fi
  document_recheck_ms="$(optional_env "$file" "DAIO_DOCUMENT_RECHECK_MS")"
  if [ -n "$document_recheck_ms" ] && ! [[ "$document_recheck_ms" =~ ^[0-9]+$ ]]; then
    die "$file DAIO_DOCUMENT_RECHECK_MS must be an integer millisecond value"
  fi
  min_commit_time_remaining_ms="$(optional_env "$file" "DAIO_MIN_COMMIT_TIME_REMAINING_MS")"
  if [ -n "$min_commit_time_remaining_ms" ] && ! [[ "$min_commit_time_remaining_ms" =~ ^[0-9]+$ ]]; then
    die "$file DAIO_MIN_COMMIT_TIME_REMAINING_MS must be an integer millisecond value"
  fi
  fallback_phase_timeout_ms="$(optional_env "$file" "DAIO_FALLBACK_PHASE_TIMEOUT_MS")"
  if [ -n "$fallback_phase_timeout_ms" ] && ! [[ "$fallback_phase_timeout_ms" =~ ^[0-9]+$ ]]; then
    die "$file DAIO_FALLBACK_PHASE_TIMEOUT_MS must be an integer millisecond value"
  fi

  keeper_enabled="$(optional_env "$file" "DAIO_KEEPER_ENABLED")"
  if [ -n "$keeper_enabled" ]; then
    is_bool "$keeper_enabled" || die "$file DAIO_KEEPER_ENABLED must be boolean-like"
    if [[ "$keeper_enabled" =~ ^(true|1|yes|on)$ ]]; then
      keeper_count=$((keeper_count + 1))
      effective_keeper_key="$keeper_key"
      if [ -z "$effective_keeper_key" ]; then
        effective_keeper_key="$global_keeper_key"
      fi
      if [ -z "$effective_keeper_key" ]; then
        warn "$file enables keeper without DAIO_KEEPER_PRIVATE_KEY; keeper txs will use AGENT_PRIVATE_KEY"
      elif [ "$effective_keeper_key" = "$tx_key" ]; then
        warn "$file keeper key equals AGENT_PRIVATE_KEY; use a dedicated funded keeper key for production"
      fi
    fi
  fi
  keeper_sync="$(optional_env "$file" "DAIO_KEEPER_SYNC_ACTIVE_REQUESTS")"
  if [ -n "$keeper_sync" ]; then
    is_bool "$keeper_sync" || die "$file DAIO_KEEPER_SYNC_ACTIVE_REQUESTS must be boolean-like"
  fi
  auto_register="$(optional_env "$file" "AGENT_AUTO_REGISTER")"
  if [ -n "$auto_register" ]; then
    is_bool "$auto_register" || die "$file AGENT_AUTO_REGISTER must be boolean-like"
  fi
  register_ens="$(optional_env "$file" "DAIO_REGISTER_ENS")"
  if [ -n "$register_ens" ]; then
    is_bool "$register_ens" || die "$file DAIO_REGISTER_ENS must be boolean-like"
  fi
  target_stake="$(optional_env "$file" "DAIO_AGENT_TARGET_STAKE_USDAIO")"
  if [ -n "$target_stake" ] && ! [[ "$target_stake" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    die "$file DAIO_AGENT_TARGET_STAKE_USDAIO must be a decimal token amount"
  fi
  if [[ "$auto_register" =~ ^(true|1|yes|on)$ ]]; then
    require_env "$file" "AGENT_ID"
    if [[ "$register_ens" =~ ^(true|1|yes|on)$ ]]; then
      require_env "$file" "AGENT_ENS_NAME"
    fi
  fi

  if [ "$tx_key" = "$vrf_key" ] || [ "$tx_key" = "$state_key" ] || [ "$vrf_key" = "$state_key" ]; then
    warn "$file reuses a transaction, VRF, or state key; use distinct secrets for production"
  fi
done

if [ "$keeper_count" -eq 0 ]; then
  warn "no .env.agent_N has DAIO_KEEPER_ENABLED=true; docker-compose defaults agent-1 to keeper, but non-compose runs need one keeper"
elif [ "$keeper_count" -gt 1 ]; then
  warn "$keeper_count agent env files enable keeper; prefer one keeper to reduce redundant startNextRequest attempts"
fi

info "Sepolia serving env files look complete"
