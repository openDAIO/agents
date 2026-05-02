# Production Serving Runbook

This runbook describes how to serve the current DAIO agent stack on a fresh AWS
EC2 instance with Docker Compose. It is written for the live Sepolia deployment
recorded in `./.deployments/sepolia.json`, not for local mock contracts.

The stack runs:

- one content API
- one MarkItDown conversion API
- five reviewer agent containers
- one local SQLite database used by the content API
- persistent local agent state directories

The agents submit transactions to Sepolia, read the deployed contracts, derive
VRF proofs from their configured VRF private keys, and actively try to join
eligible requests when the contract allows it.

## 1. Production Topology

Services:

| Service | Container | Host port | Exposure |
| --- | --- | --- | --- |
| Content API | `content-service` | `CONTENT_SERVICE_PORT`, default `18002` | expose only to your frontend/backend, VPN, or reverse proxy |
| MarkItDown API | `markitdown` | `MARKITDOWN_PORT`, default `18003` | keep private unless there is a specific trusted caller |
| Reviewer nodes | `agent-1` through `agent-5` | none | internal only |

Persistent files:

| Path | Purpose | Backup |
| --- | --- | --- |
| `.env` | shared content-service, MarkItDown, deployment, and relayer config | yes, encrypted |
| `.env.agent_*` | one independent reviewer agent config and secrets per file | yes, encrypted |
| `.deployments/sepolia.json` | contract deployment snapshot used by services | yes |
| `.data/content.sqlite` | content API documents, statuses, reasons, request metadata | yes |
| `.state/agent-*` | local reviewer runtime state | yes |

The requester is normally an external user. The requester does not need to run
inside this stack. If relayed request creation is enabled, the requester signs an
EIP-712 payload and the content API relayer wallet pays Sepolia gas.

## 2. AWS Instance

Recommended baseline for the five-agent Sepolia stack:

- AMI: Ubuntu Server 22.04 LTS or 24.04 LTS
- Instance: 8 vCPU / 32 GiB RAM, for example `c7i.2xlarge`, `m7i.2xlarge`, or
  equivalent
- Minimum for light traffic with a remote LLM: 4 vCPU / 16 GiB RAM
- Disk: 100 GiB gp3 EBS
- Network: Elastic IP if any upstream service uses IP allowlists

The current stack does not run the LLM locally. CPU and memory are mostly used by
Node.js services, MarkItDown conversions, Docker builds, and concurrent request
processing. Use a larger instance if you expect large PDFs, high conversion
volume, or a local LLM sidecar.

Security group baseline:

| Port | Source | Purpose |
| --- | --- | --- |
| `22/tcp` | operator IPs only | SSH |
| `443/tcp` | public or trusted clients | reverse proxy or API gateway, if used |
| `18002/tcp` | trusted frontend/backend, VPN, or Tailscale only | content API if exposed directly |
| `18003/tcp` | private/internal only | MarkItDown API |

Outbound HTTPS must be allowed for Sepolia RPC, the LLM endpoint, GitHub, npm,
Docker registries, and package indexes.

## 3. External Prerequisites

Before booting the instance, prepare these external dependencies.

Sepolia RPC:

- A Sepolia RPC URL with enough rate limit for five agents, the content service,
  and request traffic.
- If the provider uses IP allowlists, allow the EC2 Elastic IP.

LLM endpoint:

- An OpenAI-compatible endpoint reachable from the EC2 instance.
- Allow the EC2 Elastic IP on the LLM firewall.
- Confirm the endpoint supports the configured model and token budget.

Wallets:

- Five reviewer transaction wallets, one per agent.
- Five reviewer VRF private keys, one per agent. These are separate from the
  transaction private keys.
- Five reviewer state keys, one per agent. Each lives in that agent's
  `.env.agent_*` file and encrypts local commit-reveal seeds under
  `.state/agent-*`.
- One optional relayer transaction wallet for `CONTENT_RELAYER_PRIVATE_KEY`.
- External requester wallets, operated by users or your frontend flow.

`AGENT_PRIVATE_KEY`, `AGENT_VRF_PRIVATE_KEY`, and `AGENT_STATE_KEY` are all
32-byte secret-like values and may parse if reused in a throwaway test. Do not
reuse them in production: one leak would compromise transaction authority, VRF
sortition proofs, and commit-reveal seed encryption at once.

Funds and permissions:

- Each reviewer transaction wallet needs Sepolia ETH for transactions.
- The relayer wallet needs Sepolia ETH if relayed request creation is enabled.
- Each reviewer must be registered on-chain with the VRF public key derived from
  its own `.env.agent_N` `AGENT_VRF_PRIVATE_KEY`.
- Each reviewer must have enough USDAIO staked for the active request window.
  With `maxActiveRequests=2`, use at least `2000 USDAIO` staked per reviewer.
- Requesters need USDAIO balance and must approve the deployed `PaymentRouter`
  before using the relayed USDAIO request API.

For the current Sepolia test deployment, USDAIO is a test token used for service
validation. Follow the deployment's token minting policy for test funding; do
not assume the same policy for a mainnet deployment.

## 4. Install Docker on a Fresh EC2 Host

SSH into the instance:

```sh
ssh ubuntu@<ec2-public-ip>
```

Install Docker Engine and the Compose plugin:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git jq openssl
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Start a new shell so the Docker group applies:

```sh
newgrp docker
docker version
docker compose version
```

Enable clock sync:

```sh
sudo timedatectl set-ntp true
timedatectl status
```

Optional but recommended Docker log rotation:

```sh
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "100m",
    "max-file": "5"
  }
}
JSON
sudo systemctl restart docker
```

## 5. Clone the Repository

Clone with submodules:

```sh
git clone --recursive <repo-url> daio-agents
cd daio-agents
git submodule update --init --recursive
```

Create persistent directories:

```sh
mkdir -p .deployments .data .state
chmod 700 .data .state
cp .env.example .env
for i in 1 2 3 4 5; do cp .env.agent.example ".env.agent_$i"; done
chmod 600 .env .env.agent_*
```

Confirm the submodule commits:

```sh
git submodule status --recursive
```

The `contracts` submodule must match the ABI/spec for the deployed Sepolia
contracts. Do not replace the deployment snapshot or submodule commit unless you
are intentionally moving the service to a new deployment.

## 6. Deployment Snapshot

The production Sepolia snapshot is committed as:

```sh
.deployments/sepolia.json
```

Use it by setting:

```sh
DAIO_DEPLOYMENT_FILE=sepolia.json
```

Verify the snapshot before boot:

```sh
jq '.chainId, .contracts' .deployments/sepolia.json
```

If a new contract set is deployed, either replace `.deployments/sepolia.json` or
provide an environment override:

```sh
DAIO_DEPLOYMENT_JSON_B64=<base64-encoded deployment json>
```

Linux encoding:

```sh
base64 -w0 .deployments/sepolia.json
```

macOS encoding:

```sh
base64 < .deployments/sepolia.json | tr -d '\n'
```

## 7. Configure `.env` and `.env.agent_*`

Edit the shared `.env` on the EC2 host:

```sh
nano .env
```

Shared chain/content fields:

| Field | Required | Notes |
| --- | --- | --- |
| `RPC_URL` | yes | Sepolia RPC used by content-service and deployment checks |
| `DAIO_DEPLOYMENT_FILE` | yes | normally `sepolia.json`; compose also mounts this snapshot for agents |
| `DAIO_DEPLOYMENT_JSON_B64` | optional | use only when overriding the mounted snapshot |

Public deployment address fields in `.env.example` are documentation for
operators and downstream services. Runtime services read the deployment snapshot.

Content API fields:

| Field | Required | Notes |
| --- | --- | --- |
| `CONTENT_SERVICE_BIND` | yes | host bind address, default `127.0.0.1` |
| `CONTENT_SERVICE_PORT` | yes | host port, default `18002` |
| `CONTENT_DB_PATH` | informational | compose stores DB at `/app/data/content.sqlite` mapped from `.data` |
| `CONTENT_RELAYER_PRIVATE_KEY` | optional | enables relayed request creation |
| `CONTENT_RELAYER_CONFIRMATIONS` | optional | confirmation wait count after relayer tx |
| `CONTENT_REQUIRE_AGENT_SIGNATURES` | yes | keep `true`; requires reviewer wallet signatures on agent-written artifacts/status |

MarkItDown fields:

| Field | Required | Notes |
| --- | --- | --- |
| `MARKITDOWN_BIND` | yes | host bind address, default `127.0.0.1` |
| `MARKITDOWN_PORT` | yes | host port, default `18003` |
| `MARKITDOWN_MAX_UPLOAD_BYTES` | yes | upload limit, default 50 MiB |
| `MARKITDOWN_ENABLE_PLUGINS` | optional | keep `false` unless explicitly needed |

Then edit each agent file independently:

```sh
nano .env.agent_1
nano .env.agent_2
nano .env.agent_3
nano .env.agent_4
nano .env.agent_5
```

Each `.env.agent_N` uses the same variable names because it is injected only
into that one container. Do not place five agents' secrets in the shared `.env`.
Keep each agent file's deployment fields aligned with the shared `.env` and
mounted `.deployments/sepolia.json`; otherwise the agent and content service may
watch different contracts.

Per-agent chain/LLM fields:

| Field | Required | Notes |
| --- | --- | --- |
| `RPC_URL` | yes | Sepolia RPC used by this agent |
| `DAIO_DEPLOYMENT_FILE` | yes | normally `sepolia.json` |
| `CONTENT_SERVICE_URL` | yes | overridden to `http://content-service:18002` by bundled compose |
| `LLM_BASE_URL` | yes | OpenAI-compatible base URL chosen by this operator |
| `LLM_MODEL` | yes | model served by the LLM endpoint |
| `LLM_TIMEOUT_MS` | yes | use a high enough value for long documents |
| `LLM_MAX_TOKENS` | yes | response token budget |
| `LLM_PROPOSAL_CHAR_BUDGET` | yes | document budget before prompt construction |
| `LLM_REASONING_EFFORT` | optional | forwarded when the endpoint supports it |

Per-agent secret and identity fields:

| Field | Required | Notes |
| --- | --- | --- |
| `AGENT_STATE_KEY` | yes | 32-byte local state encryption key for this agent only |
| `AGENT_PRIVATE_KEY` | yes | transaction signer, must hold Sepolia ETH |
| `AGENT_VRF_PRIVATE_KEY` | yes | secp256k1 VRF secret used to derive proofs |
| `AGENT_ID` | if auto-registering | identity id passed to reviewer registration |
| `AGENT_ENS_NAME` | if auto-registering | ENS name passed to reviewer registration |
| `AGENT_AUTO_REGISTER` | optional | if `true`, agents attempt reviewer registration at boot |
| `DAIO_AUTO_START_REQUESTS` | yes | keep `true` for active production serving |
| `DAIO_START_REQUESTS_MAX_PER_TICK` | yes | max start attempts per polling tick, default `2` |
| `DAIO_START_REQUESTS_MIN_INTERVAL_MS` | yes | polling interval floor |
| `DAIO_START_REQUESTS_JITTER_MS` | yes | spreads agent tx timing |
| `DAIO_ALLOW_FIXTURE_VRF` | yes | keep `false` outside local mock deployments |
| `DAIO_REVIEW_ELECTION_DIFFICULTY` | fallback | agents prefer on-chain request config |
| `DAIO_AUDIT_ELECTION_DIFFICULTY` | fallback | agents prefer on-chain request config |
| `DAIO_AUDIT_TARGET_LIMIT` | fallback | agents prefer on-chain request config |
| `DAIO_REVIEW_COMMIT_GAS_FLOOR` | optional | when set, skip review-commit gas estimation and use this gas limit |
| `DAIO_REVIEW_REVEAL_GAS_FLOOR` | optional | when set, skip review-reveal gas estimation and use this gas limit |
| `DAIO_AUDIT_COMMIT_GAS_FLOOR` | optional | when set, skip audit-commit gas estimation and use this gas limit |
| `DAIO_AUDIT_REVEAL_GAS_FLOOR` | optional | when set, skip audit-reveal gas estimation and use this gas limit |

Generate per-agent state keys:

```sh
for i in 1 2 3 4 5; do printf '.env.agent_%s AGENT_STATE_KEY=0x%s\n' "$i" "$(openssl rand -hex 32)"; done
```

Generate candidate VRF keys:

```sh
for i in 1 2 3 4 5; do printf '.env.agent_%s AGENT_VRF_PRIVATE_KEY=0x%s\n' "$i" "$(openssl rand -hex 32)"; done
```

If an agent rejects a VRF key as invalid, generate a new one. Do not reuse the
same private key for transaction signing, VRF, or local state encryption.

The same `AGENT_STATE_KEY` variable name is used in every `.env.agent_N`, but
each file belongs to one agent only. Do not reuse the same value across
independent reviewers in production.

Do not put E2E-only fields such as `E2E_CHAIN_MODE`, `E2E_FORK_RPC_URL`, or
`E2E_FORK_DISABLE_IDENTITY_MODULES` into the production operational path. They
are for local validation and Sepolia fork tests only.

## 8. On-chain Preparation

Perform these checks before starting the containers.

Reviewer registration:

- If reviewers are already registered, set `AGENT_AUTO_REGISTER=false`.
- If using `AGENT_AUTO_REGISTER=true`, make sure the deployment's identity
  checks accept each agent file's `AGENT_ID` and `AGENT_ENS_NAME` values.
- The on-chain VRF public key for each reviewer must match the configured
  `AGENT_VRF_PRIVATE_KEY` in that reviewer's `.env.agent_N`. Agents refuse to
  serve when the key does not match.

Reviewer funds:

- Each `AGENT_PRIVATE_KEY` wallet in `.env.agent_N` has Sepolia ETH.
- Each reviewer has enough USDAIO balance and stake.
- For `maxActiveRequests=2`, stake at least `2000 USDAIO` per reviewer.

Relayer:

- `CONTENT_RELAYER_PRIVATE_KEY` wallet has Sepolia ETH.
- Keep this as a hot wallet with only operational gas.

Requester flow:

- Requester holds USDAIO.
- Requester approves the deployed `PaymentRouter` for the amount needed by the
  selected tier and priority fee.
- Requester signs the EIP-712 typed data returned by
  `POST /request-intents/usdaio`.

Runtime contract config:

- `DAIOCore.maxActiveRequests()` is the authoritative active request limit.
- Tier quorum, review sortition probability, audit sortition probability, and
  audit target limit are authoritative on-chain values.
- Agents read the global active request limit at boot and decode each request's
  copied config snapshot before local VRF eligibility checks.
- The env values `DAIO_REVIEW_ELECTION_DIFFICULTY`,
  `DAIO_AUDIT_ELECTION_DIFFICULTY`, and `DAIO_AUDIT_TARGET_LIMIT` are fallback
  values only.

There is no separate keeper container in this compose stack. Each reviewer agent
runs its own auto-start loop and attempts to join eligible queued requests when
capacity, VRF eligibility, and contract rules allow it.

## 9. Independence Boundaries

The protocol-critical path is chain-anchored:

- reviewer membership, stake, VRF public keys, active request limits, quorum, and
  sortition config come from contracts
- each agent signs its own transactions with `AGENT_PRIVATE_KEY` from its own
  `.env.agent_N`
- each agent derives its own VRF proofs from `AGENT_VRF_PRIVATE_KEY`
- each agent encrypts local commit-reveal seeds with its own `AGENT_STATE_KEY`
- content artifacts are addressed by canonical hashes, and agents verify
  proposal/report hashes before using fetched content

The HTTP content service is still a shared availability layer. A malicious or
unavailable content service can censor documents or artifacts, but it should not
be able to silently change proposal text or review reports without hash
verification failing.

Keep `CONTENT_REQUIRE_AGENT_SIGNATURES=true`. With that setting, `POST /reports`,
`POST /audits`, and `PUT /agent-status` must be signed by the reviewer/auditor
wallet named in the payload. This protects the status/reason API from trivial
spoofing by another HTTP caller.

The five-agent Docker Compose file is an operational convenience for one box. It
is not a trust boundary between mutually distrustful operators: a host or Docker
administrator can read every container environment and mounted state directory.
For real independent operators, run one agent per operator-controlled host or
account, each with its own `.env`, `.state`, tx key, VRF key, and state key. They
should also choose their own LLM endpoint policy instead of assuming the shared
`LLM_BASE_URL` in this convenience compose file is neutral. They may share a
public content API, or each operator may use its own content service as long as
the published `content://...` artifacts are reachable by auditors.
The current `content://` resolver is bound to the agent's configured
`CONTENT_SERVICE_URL`; true multi-service federation needs a shared gateway,
mirroring layer, or globally resolvable artifact URI scheme such as IPFS/HTTPS.

## 10. Build and Boot

Validate the compose file:

```sh
docker compose config --quiet
```

Build images:

```sh
docker compose build
```

Start the stack:

```sh
docker compose up -d
docker compose ps
```

Follow logs:

```sh
docker compose logs -f content-service
docker compose logs -f agent-1 agent-2 agent-3 agent-4 agent-5
```

Agent logs should show contract-derived config. A healthy boot includes lines
similar to:

```text
config from contract storage finality=2 reviewDiff=8000 auditDiff=10000 auditTargetLimit=2
```

If an agent exits immediately, check:

- missing `AGENT_PRIVATE_KEY` in that service's `.env.agent_N`
- missing `AGENT_VRF_PRIVATE_KEY` in that service's `.env.agent_N`
- invalid `AGENT_STATE_KEY` in that service's `.env.agent_N`
- wrong deployment snapshot
- reviewer registration or VRF public key mismatch
- no Sepolia ETH for boot-time transactions

## 11. Health Checks

From the EC2 host:

```sh
curl -sS http://127.0.0.1:18002/health
curl -sS http://127.0.0.1:18003/health
```

MarkItDown WebP conversion:

```sh
curl -sS -F file=@samples/counterexample.webp http://127.0.0.1:18003/convert
```

LLM smoke test through an agent image:

```sh
docker compose run --rm --entrypoint node agent-1 -e '
const base = process.env.LLM_BASE_URL.replace(/\/$/, "");
const body = {
  model: process.env.LLM_MODEL,
  messages: [{ role: "user", content: "Return JSON: {\"ok\":true}" }],
  max_tokens: 64,
  temperature: 0,
  response_format: { type: "json_object" }
};
fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
})
  .then(async (res) => {
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    console.log(text.slice(0, 500));
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
'
```

Optional Sepolia fork E2E validation against the deployed contract addresses:

```sh
RPC_URL=<sepolia-rpc-url> \
E2E_AGENT_COUNT=5 \
E2E_QUORUM=3 \
E2E_REQUEST_COUNT=2 \
E2E_MAX_ACTIVE_REQUESTS=2 \
E2E_REVIEW_VRF_DIFFICULTY=8000 \
E2E_AUDIT_VRF_DIFFICULTY=10000 \
DAIO_REVIEW_COMMIT_GAS_FLOOR=7000000 \
DAIO_REVIEW_REVEAL_GAS_FLOOR=2000000 \
DAIO_AUDIT_COMMIT_GAS_FLOOR=12000000 \
DAIO_AUDIT_REVEAL_GAS_FLOOR=12000000 \
npm run e2e:sepolia-fork
```

That command is a pre-production validation tool. It forks Sepolia locally and
uses `./.deployments/sepolia.json` addresses without replacing deployed contract
code. It is not the production serving process.

The reliable E2E finalization default is review VRF `8000/10000` and audit VRF
`10000/10000`. Setting both review and audit difficulty to `6000` exercises a
stricter 60% sortition path, but real audit VRF may legitimately miss quorum
for a five-agent, quorum-three run. Treat that as a stress/availability
scenario rather than a guaranteed success case.

## 12. API Flow

### Relayed USDAIO request

1. Requester approves USDAIO spending for the deployed `PaymentRouter`.
2. Frontend calls `POST /request-intents/usdaio`.
3. Requester signs the returned EIP-712 `typedData`.
4. Frontend calls `POST /requests/relayed-document` with the document and
   signature.
5. Content API sends `PaymentRouter.createRequestWithUSDAIOBySig(...)` from
   `CONTENT_RELAYER_PRIVATE_KEY`.
6. Content API verifies the emitted request event and stores the document.
7. Agents process the request through on-chain assignment, review, audit, and
   settlement.

Intent example:

```sh
curl -sS http://127.0.0.1:18002/request-intents/usdaio \
  -H 'Content-Type: application/json' \
  -d '{
    "requester": "0xRequester",
    "id": "paper-001",
    "text": "# paper markdown",
    "domainMask": "1",
    "tier": 0,
    "priorityFee": "0"
  }'
```

Relayed submission example:

```sh
curl -sS http://127.0.0.1:18002/requests/relayed-document \
  -H 'Content-Type: application/json' \
  -d '{
    "requester": "0xRequester",
    "id": "paper-001",
    "text": "# paper markdown",
    "domainMask": "1",
    "tier": 0,
    "priorityFee": "0",
    "deadline": "1770000000",
    "signature": "0xSignature"
  }'
```

### On-chain request first, document upload second

Use this path when the requester sends the on-chain request transaction directly.

1. Requester creates the on-chain request transaction.
2. Frontend waits for the transaction hash.
3. Frontend calls `POST /requests/:requestId/document`.
4. Content API verifies the on-chain request before accepting the document.

Document upload:

```sh
curl -sS http://127.0.0.1:18002/requests/<requestId>/document \
  -H 'Content-Type: application/json' \
  -d '{
    "requester": "0xRequester",
    "txHash": "0xRequestTxHash",
    "text": "# paper markdown",
    "mimeType": "text/markdown"
  }'
```

### Status and reasons

Per request agent statuses:

```sh
curl -sS http://127.0.0.1:18002/requests/<requestId>/agent-statuses
```

Single agent reason history:

```sh
curl -sS http://127.0.0.1:18002/requests/<requestId>/agents/<agentAddress>/reasons
```

Stored document:

```sh
curl -sS http://127.0.0.1:18002/requests/<requestId>/document
```

Raw hidden model chain-of-thought is not exposed by this stack. The reasons API
returns persisted review and audit reason artifacts plus raw model output fields
that the runtime explicitly stores.

## 13. MarkItDown Conversion

Convert multipart uploads:

```sh
curl -sS -F file=@paper.pdf http://127.0.0.1:18003/convert
```

Convert raw uploads:

```sh
curl -sS \
  -H 'X-Filename: paper.pdf' \
  --data-binary @paper.pdf \
  http://127.0.0.1:18003/convert
```

WebP uploads are accepted. The server pre-converts `.webp` files to PNG before
passing them to MarkItDown.

For long documents, the content path stores the submitted Markdown and the agent
prompting path applies `LLM_PROPOSAL_CHAR_BUDGET` before LLM review generation.
Increase the timeout and char budget only after confirming the LLM endpoint can
handle the larger payloads.

## 14. Network Exposure

The compose file binds APIs to `127.0.0.1` by default:

```sh
CONTENT_SERVICE_BIND=127.0.0.1
MARKITDOWN_BIND=127.0.0.1
```

For Tailscale-only access:

```sh
CONTENT_SERVICE_BIND=<tailscale-ip>
MARKITDOWN_BIND=<tailscale-ip>
```

For public traffic, prefer a reverse proxy or API gateway with TLS,
authentication, rate limits, and upload limits. Keep MarkItDown private unless a
trusted caller requires direct access.

Minimal Nginx shape for the content API:

```nginx
server {
  listen 443 ssl;
  server_name api.example.com;

  client_max_body_size 60m;

  location / {
    proxy_pass http://127.0.0.1:18002;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

Avoid exposing raw `18002` or `18003` to the public internet unless the EC2
security group, host firewall, and application-level controls are already in
place.

## 15. Operations

Update the running service:

```sh
git fetch origin
git pull --ff-only
git submodule update --init --recursive
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
```

Restart a single service:

```sh
docker compose restart agent-3
```

Stop the stack:

```sh
docker compose down
```

Do not use `docker compose down -v` in production unless you intentionally want
to remove persistent volumes and local state.

Inspect logs:

```sh
docker compose logs --tail=200 content-service
docker compose logs --tail=200 agent-1
```

Back up:

```sh
tar czf daio-backup-$(date +%Y%m%d-%H%M%S).tgz .env .env.agent_* .deployments/sepolia.json .data .state
```

Monitor:

- service health and Docker restart counts
- content DB size at `.data/content.sqlite`
- agent state growth under `.state/agent-*`
- Sepolia RPC error rate and rate-limit responses
- LLM latency, failures, and timeout rate
- relayer Sepolia ETH balance
- each agent's Sepolia ETH balance
- each agent's USDAIO stake and locked stake
- request terminal status mix: `Finalized`, `Failed`, `Unresolved`,
  `Cancelled`

## 16. Launch Checklist

AWS:

- EC2 instance created with enough CPU, memory, and disk.
- Elastic IP attached if allowlists are used.
- Security group restricts SSH, content API, and MarkItDown as described above.
- System clock sync enabled.
- Docker Engine and Compose plugin installed.

External services:

- Sepolia RPC reachable from EC2.
- RPC provider API key and IP allowlist configured.
- LLM endpoint reachable from EC2.
- EC2 Elastic IP allowed by the LLM endpoint firewall.
- Outbound access to GitHub, npm, Docker registries, and package indexes works.

Repository:

- Repo cloned with submodules.
- `git submodule status --recursive` reviewed.
- `contracts` submodule matches the deployed ABI/spec.
- `.deployments/sepolia.json` matches the deployed Sepolia contracts.

Environment:

- `.env` created from `.env.example`.
- `.env.agent_1` through `.env.agent_5` created from `.env.agent.example`.
- `.env` permission set to `600`.
- `.env.agent_*` permission set to `600`.
- `RPC_URL` set.
- `DAIO_DEPLOYMENT_FILE=sepolia.json` set, or `DAIO_DEPLOYMENT_JSON_B64` set.
- `CONTENT_RELAYER_PRIVATE_KEY` set if relayed request creation is enabled.
- `CONTENT_REQUIRE_AGENT_SIGNATURES=true`.
- Each `.env.agent_N` has `RPC_URL`, `LLM_BASE_URL`, `LLM_MODEL`, timeout, max tokens, and char budget set.
- Each `.env.agent_N` has a distinct `AGENT_STATE_KEY`.
- Each `.env.agent_N` has its own `AGENT_PRIVATE_KEY`.
- Each `.env.agent_N` has its own `AGENT_VRF_PRIVATE_KEY`.
- Each `.env.agent_N` has `DAIO_AUTO_START_REQUESTS=true`.
- Each `.env.agent_N` has `DAIO_ALLOW_FIXTURE_VRF=false`.
- Each `.env.agent_N` has `DAIO_START_REQUESTS_MAX_PER_TICK=2` unless the contract-side active request
  limit and observed latency justify a higher value.

On-chain:

- Five reviewer wallets funded with Sepolia ETH.
- Relayer wallet funded with Sepolia ETH if used.
- Five reviewers registered on-chain.
- Reviewer VRF public keys match local VRF private keys.
- Reviewers have enough USDAIO staked for the active request window.
- `DAIOCore.maxActiveRequests()` checked.
- Tier quorum and sortition settings checked.
- Requester USDAIO balance and `PaymentRouter` approval flow tested.

Boot:

- `docker compose config --quiet` passes.
- `docker compose build` succeeds.
- `docker compose up -d` starts all services.
- `curl http://127.0.0.1:18002/health` succeeds.
- `curl http://127.0.0.1:18003/health` succeeds.
- MarkItDown sample conversion succeeds.
- LLM smoke call succeeds.
- Agent logs show contract-derived config and no VRF mismatch.

Serving:

- Frontend uses `POST /request-intents/usdaio` and
  `POST /requests/relayed-document` for gas-sponsored request creation.
- Frontend uses `POST /requests/:requestId/document` only after a direct
  requester on-chain transaction.
- Frontend can read `GET /requests/:requestId/agent-statuses`.
- Frontend can read `GET /requests/:requestId/agents/:agent/reasons`.
- Content API is behind the intended network boundary.
- MarkItDown is private or exposed only to trusted callers.

Backup and recovery:

- `.env`, `.env.agent_*`, `.deployments/sepolia.json`, `.data`, and `.state` are backed up.
- Log rotation is enabled.
- Restart and update procedure has been tested.

Common launch failures:

- LLM firewall does not allow the EC2 Elastic IP.
- RPC provider blocks the EC2 Elastic IP or rate-limits the stack.
- Agent or relayer wallet lacks Sepolia ETH.
- Requester did not approve USDAIO for `PaymentRouter`.
- Reviewer is registered with a different VRF public key.
- `.deployments/sepolia.json` points at a different deployment than expected.
- `AGENT_AUTO_REGISTER=true` but identity/ENS prerequisites are not satisfied.
