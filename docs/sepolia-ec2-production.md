# Sepolia EC2 Production Quickstart

This document is the shortest path from a fresh EC2 host to the live Sepolia
DAIO agent stack. It serves the current deployment in
`.deployments/sepolia.json` and starts:

- `content-service`, including request-document, relayed-request, status, and
  reason APIs
- `markitdown`, including the document conversion API
- five independent reviewer agent containers
- one local SQLite content database
- one local state directory per agent

## 1. Install Docker On EC2

Use Ubuntu 22.04 or 24.04. The five-agent stack is comfortable on 8 vCPU and
32 GiB RAM; 4 vCPU and 16 GiB RAM is a light-traffic minimum when the LLM runs
remotely.

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git jq openssl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
newgrp docker
```

## 2. Clone The Repository

```sh
git clone --recursive git@github.com:openDAIO/agents.git daio-agents
cd daio-agents
git submodule update --init --recursive
mkdir -p .data .state
chmod 700 .data .state
```

The Sepolia deployment snapshot is already committed at
`.deployments/sepolia.json`. Do not replace it unless you are intentionally
moving to a new contract deployment.

## 3. Copy Secret Env Files

Prepare these files locally, then copy them to the EC2 checkout:

```sh
scp .env .env.agent_1 .env.agent_2 .env.agent_3 .env.agent_4 .env.agent_5 \
  ubuntu@<ec2-ip>:~/daio-agents/
```

On EC2:

```sh
cd ~/daio-agents
chmod 600 .env .env.agent_*
```

Do not copy or commit `.env.agent.raw_sample`. It is an E2E convenience file,
not a production serving file.

## 4. Shared `.env`

The shared `.env` configures the public APIs, deployment snapshot, RPC failover,
and optional relayer wallet.

Required for full API serving, including the relayer:

```sh
RPC_URL=<primary-sepolia-rpc-url>
RPC_URLS=<primary-sepolia-rpc-url>,<backup-sepolia-rpc-url>
RPC_FAILOVER_QUORUM=1
DAIO_DEPLOYMENT_FILE=sepolia.json

CONTENT_SERVICE_BIND=127.0.0.1
CONTENT_SERVICE_PORT=18002
CONTENT_REQUIRE_AGENT_SIGNATURES=true
CONTENT_RELAYER_PRIVATE_KEY=<relayer-private-key-with-sepolia-eth>
CONTENT_RELAYER_CONFIRMATIONS=1

MARKITDOWN_BIND=127.0.0.1
MARKITDOWN_PORT=18003
MARKITDOWN_MAX_UPLOAD_BYTES=52428800
MARKITDOWN_ENABLE_PLUGINS=false
```

`CONTENT_RELAYER_PRIVATE_KEY` is required if `/requests/relayed-document` should
submit Sepolia transactions. Without it, the read/write content APIs still boot,
but relayed request creation cannot complete.

The default bind values keep both APIs local to the EC2 host. To expose through
Tailscale or a private network, set `CONTENT_SERVICE_BIND` or `MARKITDOWN_BIND`
to that interface IP and open the EC2 security group only to trusted callers.
Avoid public unauthenticated exposure.

## 5. Agent Env Files

Each `.env.agent_N` is one independent reviewer operator. The Docker Compose
file starts all five on the same host for convenience, but each file must use
its own transaction key, VRF key, and state-encryption key.

Required fields per agent:

```sh
RPC_URL=<primary-sepolia-rpc-url>
RPC_URLS=<primary-sepolia-rpc-url>,<backup-sepolia-rpc-url>
DAIO_DEPLOYMENT_FILE=sepolia.json

LLM_BASE_URL=<openai-compatible-llm-base-url>
LLM_MODEL=<model-name>
LLM_TIMEOUT_MS=120000
LLM_MAX_TOKENS=8192
LLM_PROPOSAL_CHAR_BUDGET=350000
LLM_REASONING_EFFORT=low

AGENT_PRIVATE_KEY=<agent-transaction-private-key>
AGENT_VRF_PRIVATE_KEY=<agent-vrf-private-key>
AGENT_STATE_KEY=<32-byte-hex-local-state-key>
AGENT_ID=<registered-agent-id>
AGENT_ENS_NAME=<registered-agent-ens-name>
AGENT_AUTO_REGISTER=false

DAIO_AUTO_START_REQUESTS=true
DAIO_START_REQUESTS_MAX_PER_TICK=2
DAIO_START_REQUESTS_MIN_INTERVAL_MS=1000
DAIO_START_REQUESTS_JITTER_MS=250
DAIO_ALLOW_FIXTURE_VRF=false

DAIO_REVIEW_COMMIT_GAS_FLOOR=7000000
DAIO_REVIEW_REVEAL_GAS_FLOOR=2000000
DAIO_AUDIT_COMMIT_GAS_FLOOR=12000000
DAIO_AUDIT_REVEAL_GAS_FLOOR=12000000
```

Generate a state key with:

```sh
openssl rand -hex 32
```

Before serving, each agent wallet must:

- hold Sepolia ETH
- be registered in `ReviewerRegistry`
- have a registered VRF public key derived from that agent's
  `AGENT_VRF_PRIVATE_KEY`
- have enough USDAIO staked for the active request window. With
  `maxActiveRequests=2`, use at least `2000 USDAIO` staked per reviewer.

If `AGENT_AUTO_REGISTER=true`, the agent tries to register itself at boot.
For already-registered production wallets, keep it `false`; the agent will
verify the registered VRF key and refuse to start if it does not match.

## 6. Start The Stack

After cloning and copying env files:

```sh
cd ~/daio-agents
bash scripts/ops/start-sepolia-stack.sh
```

The script validates env files, builds images, starts all services, and checks
the local health endpoints.

Manual equivalent:

```sh
bash scripts/ops/check-sepolia-env.sh
docker compose --env-file .env config --quiet
docker compose --env-file .env build
docker compose --env-file .env up -d
docker compose --env-file .env ps
```

Follow logs:

```sh
docker compose --env-file .env logs -f content-service
docker compose --env-file .env logs -f agent-1
```

Healthy agent logs include:

```text
chain maxActiveRequests=2
tier Fast config from contract storage ...
started; watching events
```

## 7. Served APIs

### Content Service

Default host port: `127.0.0.1:18002`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | service health |
| `POST` | `/request-intents/usdaio` | build an EIP-712 USDAIO request intent for a requester to sign |
| `POST` | `/requests/relayed-document` | relay a signed request transaction, verify it on Sepolia, and store the document |
| `POST` | `/requests/:requestId/document` | verify a requester-created on-chain transaction and store the document |
| `GET` | `/requests/:requestId/document` | read the stored request document and verified on-chain metadata |
| `POST` | `/proposals` | store proposal text directly |
| `GET` | `/proposals/:id` | read proposal text |
| `POST` | `/reports` | store a signed reviewer report artifact |
| `GET` | `/reports/:hash` | read a reviewer report artifact |
| `POST` | `/audits` | store a signed audit artifact |
| `GET` | `/audits/:hash` | read an audit artifact |
| `PUT` | `/agent-status` | store a signed agent status update |
| `GET` | `/requests/:requestId/agents/:agent/status` | read one agent status |
| `GET` | `/requests/:requestId/agent-statuses` | list statuses for a request |
| `GET` | `/requests/:requestId/agents/:agent/reasons` | read final structured review/audit rationales for one agent |

The content service writes to `.data/content.sqlite`. It does not expose an
arbitrary filesystem read/write API.

### MarkItDown

Default host port: `127.0.0.1:18003`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | service health |
| `POST` | `/convert` | convert an uploaded file to markdown |

Raw body example:

```sh
curl -X POST http://127.0.0.1:18003/convert \
  -H 'X-Filename: paper.pdf' \
  --data-binary @paper.pdf
```

Multipart example:

```sh
curl -X POST http://127.0.0.1:18003/convert \
  -F file=@paper.pdf
```

The response includes `markdown`, `filename`, `bytes`, and `webpConverted`.
MarkItDown writes only temporary conversion files inside the container and
removes them after each request.

## 8. External Allowlist Checklist

Before declaring the EC2 host production-ready:

- allow the EC2 Elastic IP or Tailscale egress IP on the LLM endpoint
- allow the EC2 Elastic IP on RPC providers that use IP allowlists
- restrict EC2 inbound rules for `18002` and `18003`
- confirm `CONTENT_REQUIRE_AGENT_SIGNATURES=true`
- confirm requester USDAIO approval targets the deployed `PaymentRouter`
- confirm the relayer wallet has Sepolia ETH
- confirm all five reviewer wallets have Sepolia ETH and sufficient USDAIO stake
- confirm agent logs show contract-derived config and no VRF mismatch
