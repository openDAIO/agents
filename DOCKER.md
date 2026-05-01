# Docker Compose Operation

This stack runs one content API, one MarkItDown conversion API, and five reviewer agents. It is meant for a Sepolia deployment, but the same shape works with any RPC URL and matching deployment snapshot.

## 1. Prepare the host

On a fresh EC2 instance, install Docker Engine and the Docker Compose plugin, then clone with submodules:

```sh
git clone --recursive <repo-url> daio-agents
cd daio-agents
cp .env.example .env
mkdir -p .deployments .data .state
chmod 700 .data .state
chmod 600 .env
```

If you cloned without submodules:

```sh
git submodule update --init --recursive
```

## 2. Fill `.env`

Required values:

```sh
RPC_URL=https://sepolia.infura.io/v3/...
AGENT_STATE_KEY=0x...
AGENT_1_PRIVATE_KEY=0x...
AGENT_2_PRIVATE_KEY=0x...
AGENT_3_PRIVATE_KEY=0x...
AGENT_4_PRIVATE_KEY=0x...
AGENT_5_PRIVATE_KEY=0x...
```

Optional relayer value for gas-sponsored request creation:

```sh
CONTENT_RELAYER_PRIVATE_KEY=0x...
CONTENT_RELAYER_CONFIRMATIONS=1
```

If `CONTENT_RELAYER_PRIVATE_KEY` is set, the content API can accept an EIP-712 request signature from the requester and call `PaymentRouter.createRequestWithUSDAIOBySig(...)` itself. The requester still needs USDAIO balance and must approve the deployed `PaymentRouter`; the relayer only pays gas.

These keys must be funded on Sepolia and allowed by the deployed contracts. If you set `AGENT_AUTO_REGISTER=true`, the agent entrypoint will attempt registry registration with `AGENT_N_ID` and `AGENT_N_ENS_NAME`; funding, staking, and any contract-side permissions still need to be satisfied for the deployment you point at.

Generate a state key:

```sh
printf '0x%s\n' "$(openssl rand -hex 32)"
```

The deployment snapshot can be provided in either form:

```sh
cp /path/to/sepolia.json .deployments/sepolia.json
DAIO_DEPLOYMENT_FILE=sepolia.json
```

or as an environment value:

```sh
DAIO_DEPLOYMENT_JSON_B64=<base64 encoded deployment json>
```

On Linux, encode with:

```sh
base64 -w0 .deployments/sepolia.json
```

On macOS:

```sh
base64 < .deployments/sepolia.json | tr -d '\n'
```

Agent runtime config is chain-first. On startup each agent reads `DAIOCore.maxActiveRequests()` and decodes the tier runtime config from DAIOCore storage for logging. For each request it decodes that request's copied config snapshot from DAIOCore storage before local sortition/audit-target checks. The `.env` values below are fallbacks for incompatible layouts or temporary RPC read failures:

```sh
DAIO_REVIEW_ELECTION_DIFFICULTY=8000
DAIO_AUDIT_ELECTION_DIFFICULTY=10000
DAIO_AUDIT_TARGET_LIMIT=2
```

## 3. Start

```sh
docker compose up -d --build
docker compose ps
```

Health checks:

```sh
curl http://127.0.0.1:18002/health
curl http://127.0.0.1:18003/health
```

Logs:

```sh
docker compose logs -f content-service agent-1
docker compose logs -f agent-1 agent-2 agent-3 agent-4 agent-5
```

## 4. Document conversion

The MarkItDown service converts uploaded files into Markdown. Submit the returned Markdown to the content API request document endpoint.

```sh
curl -sS -F file=@paper.pdf http://127.0.0.1:18003/convert
```

For raw uploads:

```sh
curl -sS \
  -H 'X-Filename: paper.pdf' \
  --data-binary @paper.pdf \
  http://127.0.0.1:18003/convert
```

WebP uploads are accepted; the server pre-converts `.webp` files to PNG before handing them to MarkItDown.

## 5. Relayed USDAIO request API

The requester first approves USDAIO to the deployed `PaymentRouter`. Then ask the content API for the typed data to sign:

```sh
curl -sS http://127.0.0.1:18002/request-intents/usdaio \
  -H 'Content-Type: application/json' \
  -d '{
    "requester": "0x...",
    "id": "paper-001",
    "text": "# paper markdown",
    "domainMask": "1",
    "tier": 0,
    "priorityFee": "0"
  }'
```

Sign the returned `typedData` with the requester wallet, then submit the document and signature:

```sh
curl -sS http://127.0.0.1:18002/requests/relayed-document \
  -H 'Content-Type: application/json' \
  -d '{
    "requester": "0x...",
    "id": "paper-001",
    "text": "# paper markdown",
    "domainMask": "1",
    "tier": 0,
    "priorityFee": "0",
    "deadline": "1770000000",
    "signature": "0x..."
  }'
```

The response contains the relayer TX hash, created `requestId`, and the stored verified document.

## 6. Networking and security

By default, the APIs bind to `127.0.0.1` on the host. For Tailscale-only access, set:

```sh
CONTENT_SERVICE_BIND=<tailscale-ip>
MARKITDOWN_BIND=<tailscale-ip>
```

Avoid binding to `0.0.0.0` unless the EC2 security group, host firewall, and any API authentication layer are already configured. Private keys live in `.env`, so keep that file out of Git and restrict filesystem access. Treat `CONTENT_RELAYER_PRIVATE_KEY` like a hot wallet key and fund it only with operational gas.

## 7. Operational notes

The content service persists SQLite data under `./.data/content.sqlite`; agent local state is under `./.state/agent-*`. The contracts are compiled inside the app image so ABI artifacts match the checked-out contracts submodule.

Agents run with `DAIO_AUTO_START_REQUESTS=true` and will actively try to join eligible requests whenever the contract allows it. Tune `DAIO_START_REQUESTS_MAX_PER_TICK`, `DAIO_START_REQUESTS_MIN_INTERVAL_MS`, and the contract-side active request limit together when increasing throughput. Sortition and audit-target parameters should be changed on the contract tier config; the agent reads the request snapshot from chain and uses env values only as fallback.

## 8. Production serving checklist

Use this checklist before opening a new EC2 deployment to real traffic.

### External allowlists

- Attach an Elastic IP to the EC2 instance if any upstream service uses IP allowlists.
- Allow the EC2 Elastic IP on the LLM endpoint firewall. With the default config, the EC2 instance must reach `LLM_BASE_URL` on its OpenAI-compatible API port.
- Check any Sepolia RPC provider IP allowlist, API key domain restrictions, and rate limits.
- Confirm EC2 outbound access to the Sepolia RPC URL, the LLM endpoint, GitHub, npm, Docker registries, and Python package indexes.
- Confirm system time is synchronized. Bad clock drift can break request deadlines and makes chain/log debugging harder.

### Chain and wallets

- Confirm `./.deployments/sepolia.json` matches the contracts deployed on Sepolia.
- Confirm the checked-out `contracts` submodule commit matches the deployment ABI/spec.
- Fund all five agent wallets with Sepolia ETH.
- Fund the relayer wallet in `CONTENT_RELAYER_PRIVATE_KEY` with Sepolia ETH.
- Register all five agent wallets as reviewers.
- Stake enough USDAIO for the active request window. With `maxActiveRequests=2`, each reviewer should have at least `2000 USDAIO` staked.
- Confirm requesters have USDAIO balance and have approved the deployed `PaymentRouter`.
- Confirm `DAIOCore.maxActiveRequests()`, the Fast tier quorum, and review/audit sortition settings match the intended production profile.

### Host files and environment

- Keep `.env` out of Git and restrict it with `chmod 600 .env`.
- Set `RPC_URL`.
- Set `DAIO_DEPLOYMENT_FILE=sepolia.json`, or provide `DAIO_DEPLOYMENT_JSON_B64`.
- Set `LLM_BASE_URL`, `LLM_MODEL`, `LLM_TIMEOUT_MS`, `LLM_MAX_TOKENS`, and `LLM_PROPOSAL_CHAR_BUDGET`.
- Set `CONTENT_RELAYER_PRIVATE_KEY` if the content API should relay signed USDAIO request intents.
- Set `AGENT_STATE_KEY` to a 32-byte hex value.
- Set `AGENT_1_PRIVATE_KEY` through `AGENT_5_PRIVATE_KEY`.
- Keep fallback values in `.env`: `DAIO_REVIEW_ELECTION_DIFFICULTY=8000`, `DAIO_AUDIT_ELECTION_DIFFICULTY=10000`, and `DAIO_AUDIT_TARGET_LIMIT=2`.
- Ensure `./.deployments/sepolia.json` exists when using `DAIO_DEPLOYMENT_FILE`.
- Ensure `./.data` and `./.state` exist and are included in the backup plan.

### Network exposure

- Keep MarkItDown private unless there is a specific reason to expose it.
- Put public Content API traffic behind TLS, authentication, rate limits, and upload size controls.
- Avoid exposing `18002` or `18003` directly to the public internet.
- Security group baseline:
  - SSH `22/tcp`: operator IPs only.
  - Content API `18002/tcp`: frontend backend, VPN, Tailscale, or another trusted source only.
  - MarkItDown `18003/tcp`: private/internal only.
  - HTTPS `443/tcp`: public only if a reverse proxy or API gateway is configured.

### Pre-boot checks

```sh
git submodule status --recursive
docker compose config --quiet
docker compose build
```

Compile contracts with the same optimizer profile used for deployment:

```sh
OPTIMIZER_RUNS=10 npm run compile-contracts
```

### Boot and smoke tests

```sh
docker compose up -d
docker compose ps
docker compose logs -f content-service
docker compose logs -f agent-1 agent-2 agent-3 agent-4 agent-5
```

Health checks:

```sh
curl http://127.0.0.1:18002/health
curl http://127.0.0.1:18003/health
```

MarkItDown smoke test:

```sh
curl -sS -F file=@samples/counterexample.webp http://127.0.0.1:18003/convert
```

LLM smoke test:

```sh
npm run smoke-llm
```

Agent logs should show chain-derived config, for example:

```text
config from contract storage finality=2 reviewDiff=8000 auditDiff=10000 auditTargetLimit=2
```

### Request flow smoke test

- Ask the requester wallet to approve `USDAIO` spending for the deployed `PaymentRouter`.
- Call `POST /request-intents/usdaio`.
- Sign the returned typed data with the requester wallet.
- Call `POST /requests/relayed-document`.
- Check `GET /requests/:requestId/document`.
- Check `GET /requests/:requestId/agent-statuses`.

### Monitoring

- Relayer Sepolia ETH balance.
- Agent Sepolia ETH balances.
- Agent USDAIO stake and locked stake.
- RPC rate-limit and error rate.
- LLM latency and error rate.
- Content DB size at `./.data/content.sqlite`.
- Agent state growth under `./.state/agent-*`.
- Docker restart count and service health.
- Request terminal status mix: `Finalized`, `Failed`, `Unresolved`, `Cancelled`.

### Backups

Back up these files/directories:

- `.env`
- `./.deployments/sepolia.json`
- `./.data/content.sqlite`
- `./.state/agent-*`

Common launch failures to check first:

- The LLM firewall does not allow the EC2 Elastic IP.
- The relayer or agent wallets do not have enough Sepolia ETH.
- The requester has not approved USDAIO for `PaymentRouter`.
- The deployment snapshot points at a different Sepolia deployment than the one the agents are watching.
