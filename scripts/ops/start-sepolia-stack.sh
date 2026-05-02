#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose --env-file .env)

env_get() {
  local key="$1"
  { grep -E "^[[:space:]]*${key}=" .env 2>/dev/null || true; } \
    | tail -n 1 \
    | sed -E "s/^[[:space:]]*${key}=//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^\"(.*)\"$/\\1/; s/^'(.*)'$/\\1/"
}

printf '[serve] validating Sepolia production env files\n'
scripts/ops/check-sepolia-env.sh

printf '[serve] preparing persistent directories\n'
mkdir -p .data .state
chmod 700 .data .state
chmod 600 .env .env.agent_*

printf '[serve] validating compose config\n'
"${COMPOSE[@]}" config --quiet

printf '[serve] building images\n'
"${COMPOSE[@]}" build content-service markitdown

printf '[serve] starting content-service, markitdown, and five agents\n'
"${COMPOSE[@]}" up -d

printf '[serve] waiting for Docker health checks\n'
for _ in $(seq 1 60); do
  content_status="$(docker inspect --format '{{.State.Health.Status}}' "$(basename "$ROOT")-content-service-1" 2>/dev/null || true)"
  markitdown_status="$(docker inspect --format '{{.State.Health.Status}}' "$(basename "$ROOT")-markitdown-1" 2>/dev/null || true)"
  if [ "$content_status" = "healthy" ] && [ "$markitdown_status" = "healthy" ]; then
    break
  fi
  sleep 2
done

"${COMPOSE[@]}" ps

printf '\n[serve] local health checks\n'
content_port="$(env_get CONTENT_SERVICE_PORT)"
markitdown_port="$(env_get MARKITDOWN_PORT)"
content_bind="$(env_get CONTENT_SERVICE_BIND)"
markitdown_bind="$(env_get MARKITDOWN_BIND)"
content_port="${content_port:-18002}"
markitdown_port="${markitdown_port:-18003}"
content_bind="${content_bind:-127.0.0.1}"
markitdown_bind="${markitdown_bind:-127.0.0.1}"
[ "$content_bind" = "0.0.0.0" ] && content_bind="127.0.0.1"
[ "$markitdown_bind" = "0.0.0.0" ] && markitdown_bind="127.0.0.1"

curl -fsS "http://${content_bind}:${content_port}/health" >/dev/null
printf '[serve] content-service ok on %s:%s\n' "$content_bind" "$content_port"
curl -fsS "http://${markitdown_bind}:${markitdown_port}/health" >/dev/null
printf '[serve] markitdown ok on %s:%s\n' "$markitdown_bind" "$markitdown_port"

printf '\n[serve] Sepolia stack is running. Follow logs with:\n'
printf '  docker compose --env-file .env logs -f content-service\n'
printf '  docker compose --env-file .env logs -f agent-1\n'
