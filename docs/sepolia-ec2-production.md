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

For full API serving, including requester-sponsored relayed requests, provide:

- `.env` with Sepolia RPCs, `CONTENT_RELAYER_PRIVATE_KEY`, content-service
  settings, and MarkItDown settings
- `.env.agent_1` through `.env.agent_5`, one independent reviewer config per
  agent
- five registered/staked reviewer wallets with matching VRF keys
- one funded relayer wallet for the content-service relayed-request API
- one funded keeper gas wallet when `DAIO_KEEPER_PRIVATE_KEY` is set

## 0. One-Page Deployment Path

On a fresh EC2 host:

```sh
sudo apt-get update
sudo apt-get install -y git ca-certificates curl gnupg
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker

git clone --recursive git@github.com:openDAIO/agents.git daio-agents
cd daio-agents
git submodule update --init --recursive
```

From the operator workstation, copy only the secret env files into the checkout:

```sh
scp .env .env.agent_1 .env.agent_2 .env.agent_3 .env.agent_4 .env.agent_5 \
  ubuntu@<ec2-ip>:~/daio-agents/
```

Then start the Sepolia production stack:

```sh
cd ~/daio-agents
chmod 600 .env .env.agent_*
bash scripts/ops/start-sepolia-stack.sh
```

The script validates env files, builds Docker images, starts `content-service`,
`markitdown`, and `agent-1..5`, then checks local health endpoints. Use:

```sh
docker compose --env-file .env ps
docker compose --env-file .env logs -f content-service
docker compose --env-file .env logs -f agent-1
```

If the frontend is public, keep `CONTENT_SERVICE_BIND=127.0.0.1` and expose the
content API through HTTPS reverse proxy/API gateway. Only bind service ports to
`0.0.0.0` or a private interface when the EC2 security group already restricts
the source addresses.

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
moving to a new contract deployment. The current snapshot uses
`ConsensusScoring` `0xe271d90C72D9a8D931f337C144C6C4e204F994ed`; the previous
deployment `0xEf348E9658087F7F459dE35207EF02bEb6923aaE` is retained only in
`previousConsensusScoring` for operator history.

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
RPC_BATCH_MAX_COUNT=1
RPC_READ_RETRIES=3
RPC_READ_RETRY_BASE_MS=500
RPC_TX_WAIT_RETRIES=5
RPC_TX_WAIT_RETRY_BASE_MS=1000
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

CORS_ALLOW_ORIGIN=*
CORS_ALLOW_METHODS=GET,POST,PUT,PATCH,DELETE,OPTIONS
CORS_ALLOW_HEADERS=Content-Type,Authorization,X-Requested-With,X-Filename
CORS_EXPOSE_HEADERS=Content-Length,Content-Type
CORS_MAX_AGE=86400
CORS_ALLOW_CREDENTIALS=false

DAIO_DOCUMENT_WAIT_MS=300000
DAIO_DOCUMENT_RETRY_INITIAL_MS=1000
DAIO_DOCUMENT_RETRY_MAX_MS=10000
DAIO_DOCUMENT_RECHECK_MS=10000
DAIO_MIN_COMMIT_TIME_REMAINING_MS=120000
DAIO_FALLBACK_PHASE_TIMEOUT_MS=600000
DAIO_EVENT_LOOKBACK_BLOCKS=7200
DAIO_EVENT_REORG_DEPTH_BLOCKS=12
DAIO_KEEPER_RECONCILE_INTERVAL_MS=10000
DAIO_KEEPER_SYNC_ACTIVE_REQUESTS=true
DAIO_KEEPER_SYNC_MAX_PER_TICK=8
DAIO_KEEPER_PRIVATE_KEY=<dedicated-keeper-gas-private-key>
DAIO_START_NEXT_REQUEST_GAS_FLOOR=300000
DAIO_SYNC_REQUEST_GAS_FLOOR=2000000
```

`CONTENT_RELAYER_PRIVATE_KEY` is required if `/requests/relayed-document` should
submit Sepolia transactions. Without it, the read/write content APIs still boot,
but relayed request creation cannot complete.

Use at least two unique RPC endpoints in `RPC_URL`/`RPC_URLS` for production
traffic. `RPC_BATCH_MAX_COUNT=1` disables ethers batching for public RPC
compatibility, and retryable provider failures such as `408`, `429`, and
transient network errors are retried/logged instead of crashing the agent
process. Public free-tier RPCs can still add latency under load; paid or
dedicated Sepolia RPCs are preferred for sustained testing.

If you keep the informational `DAIO_CONSENSUS_SCORING_ADDRESS` env variable in
operator files, it must match the deployment snapshot:
`0xe271d90C72D9a8D931f337C144C6C4e204F994ed`.

When a direct on-chain request enters an active phase before its document is
registered in content-service, agents keep the request tracked and report
`waiting_document` for the full remaining active phase. They no longer mark
`document_unavailable` early because of a document deadline buffer. If the
document finally appears too close to the commit deadline,
`DAIO_MIN_COMMIT_TIME_REMAINING_MS` prevents starting LLM/commit work that is
unlikely to land before the phase closes; keeper reconciliation then lets the
contract timeout path free the active slot.

Full API serving means:

- `CONTENT_RELAYER_PRIVATE_KEY` is set and funded, enabling
  `POST /requests/relayed-document`.
- `CONTENT_REQUIRE_AGENT_SIGNATURES=true`, enabling signed agent artifact/status
  writes while rejecting unsigned impersonation attempts.
- `content-service` is reachable by the frontend or API gateway, enabling
  request, document, markdown, status, reason, report, and audit endpoints.
- `markitdown` is reachable by the upload path that needs conversion, enabling
  `POST /convert`.

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
RPC_BATCH_MAX_COUNT=1
RPC_READ_RETRIES=3
RPC_READ_RETRY_BASE_MS=500
RPC_TX_WAIT_RETRIES=5
RPC_TX_WAIT_RETRY_BASE_MS=1000
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
DAIO_REGISTER_ENS=false
DAIO_AGENT_TARGET_STAKE_USDAIO=6000

DAIO_AUTO_START_REQUESTS=true
DAIO_KEEPER_ENABLED=false
DAIO_KEEPER_PRIVATE_KEY=
DAIO_KEEPER_RECONCILE_INTERVAL_MS=10000
DAIO_KEEPER_SYNC_ACTIVE_REQUESTS=true
DAIO_KEEPER_SYNC_MAX_PER_TICK=8
DAIO_START_NEXT_REQUEST_GAS_FLOOR=300000
DAIO_SYNC_REQUEST_GAS_FLOOR=2000000
DAIO_START_REQUESTS_MAX_PER_TICK=2
DAIO_START_REQUESTS_MIN_INTERVAL_MS=1000
DAIO_START_REQUESTS_JITTER_MS=250
DAIO_DOCUMENT_WAIT_MS=300000
DAIO_DOCUMENT_RETRY_INITIAL_MS=1000
DAIO_DOCUMENT_RETRY_MAX_MS=10000
DAIO_DOCUMENT_RECHECK_MS=10000
DAIO_MIN_COMMIT_TIME_REMAINING_MS=120000
DAIO_FALLBACK_PHASE_TIMEOUT_MS=600000
DAIO_EVENT_LOOKBACK_BLOCKS=7200
DAIO_EVENT_REORG_DEPTH_BLOCKS=12
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

When using the bundled Docker Compose file, only `agent-1` is keeper-enabled by
default. The other agents still process review/audit phases but do not send
`startNextRequest` transactions. Override `DAIO_KEEPER_ENABLED_AGENT_N` in
`.env` if ownership should move. Set `DAIO_KEEPER_PRIVATE_KEY` in `.env` for a
single shared dedicated keeper gas wallet, or in only the keeper-enabled
`.env.agent_N` for a per-agent keeper key. Review and audit commit-reveal
transactions still use `AGENT_PRIVATE_KEY`, because reviewer identity is tied to
`msg.sender`.

The keeper also syncs active requests. It first uses
`syncRequest.staticCall(requestId)` and sends a real transaction only when the
contract would advance the request, so a document-missing request can release
its active slot once the protocol timeout has elapsed. Keeper transaction gas
floors are intentionally higher than typical estimates to avoid out-of-gas
reverts when queue/sync state changes between estimate and mining. Active sync
is de-duped per request while a sync is already in flight, so reconcile ticks or
event replay do not send redundant `syncRequest` transactions for the same
request.

Before serving, each agent wallet must:

- hold Sepolia ETH for review/audit commit-reveal gas
- be registered in `ReviewerRegistry`
- have a registered VRF public key derived from that agent's
  `AGENT_VRF_PRIVATE_KEY`
- have enough USDAIO staked for the active request window. With
  `maxActiveRequests=2`, use at least `2000 USDAIO` staked per reviewer; the
  current shared Sepolia profile uses about `6000 USDAIO` per reviewer for a
  wider buffer.

Recommended live Sepolia funding baselines:

| Account | Purpose | Minimum | Comfortable test buffer |
| --- | --- | ---: | ---: |
| Reviewer agent wallet | review/audit commit-reveal gas | `0.03 ETH` each | `0.05 ETH` each |
| Reviewer stake | sortition eligibility for `maxActiveRequests=2` | `2000 USDAIO` each | `6000 USDAIO` each |
| Content relayer wallet | `/requests/relayed-document` gas | `0.02 ETH` | `0.05 ETH` |
| Keeper wallet | `startNextRequest` and `syncRequest` gas | `0.02 ETH` | `0.05 ETH` |
| Requester wallet | direct-request gas, if bypassing relayer | `0.01 ETH` | `0.03 ETH` |
| Requester USDAIO | request fees | `baseRequestFee + priorityFee` per request | enough for planned batch size |

The content relayer does not need USDAIO for relayed USDAIO requests; the
request fee is pulled from the requester through `PaymentRouter` allowance. The
requester must approve at least `baseRequestFee + priorityFee` for each request,
or use a larger allowance for repeated tests.

If `AGENT_AUTO_REGISTER=true`, the agent tries to register itself at boot.
For already-registered production wallets, keep it `false`; the agent will
verify the registered VRF key and refuse to start if it does not match.
The agent registration helper does not use an identityless stake top-up
fallback, so failed ENS/ERC-8004 verification will leave existing on-chain
identity fields untouched instead of clearing them.

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

All endpoints below are available after `scripts/ops/start-sepolia-stack.sh`
starts healthy containers. Endpoints that send Sepolia transactions additionally
need the configured relayer/reviewer wallet to be funded and authorized on-chain.

### Content Service

Default host port: `127.0.0.1:18002`.

For a browser frontend, expose this service through the same HTTPS origin or
through an API gateway/reverse proxy. Docker Compose passes `CORS_ALLOW_*`
values into the service, so the built-in server can answer browser preflight
requests for local or public testing. For production, keep requester-facing
write endpoints authenticated/rate-limited and keep agent-only write endpoints
signed with
`CONTENT_REQUIRE_AGENT_SIGNATURES=true`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | service health |
| `POST` | `/request-intents/usdaio` | build an EIP-712 USDAIO request intent for a requester to sign |
| `POST` | `/requests/relayed-document` | preflight and relay a signed request transaction, verify it on Sepolia, and store the document |
| `POST` | `/requests/document-from-tx` | recover document storage from a successful payment tx hash |
| `POST` | `/requests/:requestId/document` | verify a requester-created on-chain transaction and store the document |
| `GET` | `/requests/:requestId/document` | read the stored request document and verified on-chain metadata |
| `GET` | `/requests/:requestId/chain-status` | read current on-chain lifecycle directly from Sepolia |
| `GET` | `/requests/:requestId/markdown` | read the canonical converted Markdown for third-party reviewers |
| `POST` | `/proposals` | store proposal text directly |
| `GET` | `/proposals/:id` | read proposal text |
| `GET` | `/proposals/:id/markdown` | read proposal Markdown directly; use `?format=raw` for `text/markdown` |
| `POST` | `/reports` | store a signed reviewer report artifact |
| `GET` | `/reports/:hash` | read a reviewer report artifact |
| `POST` | `/audits` | store a signed audit artifact |
| `GET` | `/audits/:hash` | read an audit artifact |
| `PUT` | `/agent-status` | store a signed agent status update |
| `GET` | `/requests/:requestId/agents/:agent/status` | read one agent status |
| `GET` | `/requests/:requestId/agent-statuses` | list statuses for a request |
| `GET` | `/requests/:requestId/agents/:agent/reasons` | read final structured review/audit rationales for one agent |
| `POST` | `/requests/:requestId/agents/:agent/ask` | ask an agent-scoped question using current request, chain, artifact, event, and Q&A context |
| `GET` | `/requests/:requestId/agents/:agent/qa-history` | read stored Q&A rows for one request, agent, and session |
| `POST` | `/requests/:requestId/agents/:agent/score-report` | generate or read a cached finalized score report for one agent |
| `POST` | `/requests/:requestId/final-report` | generate or read a cached synthesized finalized request report |

The content service writes to `.data/content.sqlite`. It does not expose an
arbitrary filesystem read/write API.

For third-party agents, prefer `GET /requests/:requestId/markdown`. It returns
JSON metadata plus `proposal.markdown` by default. Passing `?format=raw` or
`Accept: text/markdown` returns only the Markdown body and includes
`ETag`, `X-DAIO-Proposal-URI`, and `X-DAIO-Proposal-Hash` headers.

Agent Q&A endpoints are public in this deployment profile. They do not expose
raw hidden model reasoning, private keys, seeds, or local `.state` material.
They answer with currently persisted structured context: request documents,
chain lifecycle, agent status/events, final review/audit artifacts when present,
and recent Q&A history for the selected `sessionId`.
Finalized report endpoints use the same safe context family, require the
contract lifecycle to be `Finalized`, and cache generated JSON in SQLite. Score
and audit attribution in those reports follows the finalized on-chain accepted
review/audit participant lists, so late off-chain artifacts that missed contract
acceptance are described as caveats instead of counted scores.

Example from a live Sepolia run finalized on 2026-05-03:

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -d '{"sessionId":"live-e2e","question":"Summarize your final review and audit judgment."}' \
  http://127.0.0.1:18002/requests/13/agents/0x66ff396457F3df77c6d520f0f3BBb05e4794E057/ask
```

The response used the finalized request context:

```json
{
  "requestId": "13",
  "confidence": 9700,
  "contextUsed": {
    "hasDocument": true,
    "hasReview": true,
    "hasAudit": true,
    "agentStatus": "Finalized:finalized",
    "historyUsed": 2,
    "eventsUsed": 16,
    "chainStatus": "Finalized"
  }
}
```

Finalized report examples from live Sepolia request `18`:

```bash
curl -sS -X POST \
  http://127.0.0.1:18002/requests/18/agents/0x66ff396457F3df77c6d520f0f3BBb05e4794E057/score-report

curl -sS -X POST \
  http://127.0.0.1:18002/requests/18/agents/0x08913F98a37FCC24CB825fB6db7599086A5f8f56/score-report

curl -sS -X POST http://127.0.0.1:18002/requests/18/final-report
```

Observed excerpts:

```json
{
  "r1ScoreReport": {
    "cached": false,
    "participation": "reviewer_and_auditor",
    "proposalScore": 6200,
    "auditTargetCount": 2
  },
  "r4ScoreReport": {
    "cached": false,
    "participation": "skipped",
    "scoreGiven": null,
    "auditGiven": null
  },
  "finalReport": {
    "cached": false,
    "agentCount": 5,
    "finalScore": 6200,
    "scoreSpread": "Proposal scores ranged from 6200 to 6200 across 3 scoring agents."
  },
  "repeatCalls": {
    "scoreReportCached": true,
    "finalReportCached": true
  }
}
```

On-chain contract views/events remain the source of truth for request lifecycle,
participants, scores, rewards, and slashing. Content API rows are the off-chain
document/rationale/status cache used by the frontend and third-party agents.

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
- confirm the keeper wallet has Sepolia ETH
- confirm all five reviewer wallets have Sepolia ETH and sufficient USDAIO stake
- confirm agent logs show contract-derived config and no VRF mismatch
