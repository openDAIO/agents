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

For the shortest EC2 path, see
[`docs/sepolia-ec2-production.md`](docs/sepolia-ec2-production.md). After the
secret env files are copied into the checkout, this command validates the env
surface, builds the images, starts every API and agent container, and checks the
local health endpoints:

```sh
bash scripts/ops/start-sepolia-stack.sh
```

That clone/scp/start path is the intended production path for full Sepolia API
serving. With `CONTENT_RELAYER_PRIVATE_KEY` set and funded, it enables relayed
request creation, direct document submission, canonical Markdown reads,
status/reason reads, signed report/audit/status writes, MarkItDown conversion,
and all five reviewer agents.

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

### New Contract Deployment Path

The current `contracts` submodule includes a staged deployment helper,
`contracts/scripts/deploy-via-deployer.js`, backed by
`contracts/contracts/deploy/DAIOSystemDeployer.sol`. Use this path when you are
intentionally deploying a new DAIO contract set, not when you are only serving
the already deployed Sepolia addresses.

Compile with the production optimizer profile before deploying:

```sh
cd contracts
npm ci
OPTIMIZER_RUNS=10 npx hardhat compile
```

The 0.8.24 contracts compile with `runs=10`, `viaIR=true`, and
`bytecodeHash=none`; the 0.6.12 wrapper compiler keeps `runs=200` from
`hardhat.config.js`.

Sepolia deployment requires a funded deployer key and the external integration
addresses. The script already knows the current Sepolia defaults, but production
operators should pass them explicitly when moving to a new environment:

```sh
SEPOLIA_RPC_URL=<sepolia-rpc-url> \
PRIVATE_KEY=<deployer-private-key> \
ENS_REGISTRY_ADDRESS=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e \
ERC8004_IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e \
ERC8004_REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713 \
UNIVERSAL_ROUTER_ADDRESS=0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b \
POOL_MANAGER_ADDRESS=0xE03A1074c86CFeDd5C142C4F04F1a1536e203543 \
npx hardhat run scripts/deploy-via-deployer.js --network sepolia
```

Optional deployment toggles:

| Field | Default | Notes |
| --- | --- | --- |
| `ENABLE_ENS_VERIFIER` | `true` | deploy and wire ENS verifier |
| `ENABLE_ERC8004_ADAPTER` | `true` | deploy and wire ERC-8004 adapter |
| `ENABLE_AUTO_CONVERT_HOOK` | `true` | deploy and wire Uniswap v4 auto-convert hook |

The helper wires the same operational profile used by the current Sepolia
deployment: `maxActiveRequests=2`, review quorum `4`, audit quorum `4`, review
sortition `10000/10000`, audit sortition `10000/10000`, and Fast-tier audit
target limit `3`.

After a new deployment, convert the printed addresses into
`.deployments/sepolia.json`, update the public address fields in `.env.example`,
rebuild the Docker image, and run Sepolia fork validation before serving
traffic. The agent stack reads the deployment snapshot at runtime; it does not
discover a new deployment automatically.

## 7. Configure `.env` and `.env.agent_*`

Edit the shared `.env` on the EC2 host:

```sh
nano .env
```

Shared chain/content fields:

| Field | Required | Notes |
| --- | --- | --- |
| `RPC_URL` | yes | Sepolia RPC used by content-service and deployment checks |
| `RPC_URLS` | recommended | comma- or space-separated fallback RPC endpoints; `RPC_URL` is tried first |
| `CONTENT_CHAIN_RPC_URLS` | optional | content-service-specific fallback list; defaults to `RPC_URLS` when omitted |
| `RPC_FAILOVER_STALL_TIMEOUT_MS` | optional | delay before the next RPC backend is tried, default `750` |
| `RPC_FAILOVER_QUORUM` | optional | backend response quorum, default `1` for availability |
| `RPC_FAILOVER_EVENT_QUORUM` | optional | event polling quorum, default `1` |
| `RPC_FAILOVER_EVENT_WORKERS` | optional | event backend workers, default `2` |
| `RPC_FAILOVER_CACHE_TIMEOUT_MS` | optional | provider cache timeout, default `250` |
| `DAIO_DEPLOYMENT_FILE` | yes | normally `sepolia.json`; compose also mounts this snapshot for agents |
| `DAIO_DEPLOYMENT_JSON_B64` | optional | use only when overriding the mounted snapshot |

Public deployment address fields in `.env.example` are documentation for
operators and downstream services. Runtime services read the deployment snapshot.
Treat RPC URLs with API keys as operational secrets. The bundled defaults use
public endpoints for quick start only; production should provide at least two
dedicated Sepolia RPC providers in `RPC_URLS`.

Content API fields:

| Field | Required | Notes |
| --- | --- | --- |
| `CONTENT_SERVICE_BIND` | yes | host bind address, default `127.0.0.1` |
| `CONTENT_SERVICE_PORT` | yes | host port, default `18002` |
| `CONTENT_DB_PATH` | informational | compose stores DB at `/app/data/content.sqlite` mapped from `.data` |
| `CONTENT_RELAYER_PRIVATE_KEY` | optional | enables relayed request creation |
| `CONTENT_RELAYER_CONFIRMATIONS` | optional | confirmation wait count after relayer tx, default `1` |
| `DAIO_TX_FINALITY_CONFIRMATIONS` | optional | tx/event finality confirmations before dependent reads/actions, default `1` |
| `DAIO_TX_FINALITY_WAIT_TIMEOUT_MS` | optional | max wait for externally supplied tx hashes to reach finality, default `300000` |
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
| `RPC_URLS` | recommended | per-agent fallback RPC list; use endpoints owned by that operator |
| `RPC_FAILOVER_STALL_TIMEOUT_MS` | optional | delay before trying the next RPC backend, default `750` |
| `RPC_FAILOVER_QUORUM` | optional | backend response quorum, default `1` |
| `RPC_FAILOVER_EVENT_QUORUM` | optional | event polling quorum, default `1` |
| `DAIO_DEPLOYMENT_FILE` | yes | normally `sepolia.json` |
| `CONTENT_SERVICE_URL` | yes | overridden to `http://content-service:18002` by bundled compose |
| `LLM_BASE_URL` | yes | OpenAI-compatible base URL chosen by this operator |
| `LLM_MODEL` | yes | model served by the LLM endpoint |
| `LLM_TIMEOUT_MS` | yes | use a high enough value for long documents |
| `LLM_MAX_TOKENS` | yes | response token budget |
| `LLM_PROPOSAL_CHAR_BUDGET` | yes | document budget before prompt construction |
| `LLM_REASONING_EFFORT` | optional | forwarded when the endpoint supports it |
| `LLM_RESPONSE_CACHE_TTL_SECONDS` | optional | response cache TTL in seconds; default `0` means no TTL expiry |
| `LLM_RESPONSE_CACHE_MAX_ENTRIES` | optional | response cache size cap; default `4096`, evicts least-recently accessed entries |
| `LLM_RESPONSE_CACHE_DB_PATH` | optional | SQLite response cache path; agents default under `AGENT_STATE_DIR`, content-service defaults under `/app/data` |
| `DAIO_TX_FINALITY_CONFIRMATIONS` | optional | tx/event finality confirmations before LLM/cache-dependent work, default `1` |

Per-agent secret and identity fields:

| Field | Required | Notes |
| --- | --- | --- |
| `AGENT_STATE_KEY` | yes | 32-byte local state encryption key for this agent only |
| `AGENT_PRIVATE_KEY` | yes | transaction signer, must hold Sepolia ETH |
| `AGENT_VRF_PRIVATE_KEY` | yes | secp256k1 VRF secret used to derive proofs |
| `DAIO_KEEPER_PRIVATE_KEY` | optional | dedicated gas signer for keeper-only `startNextRequest`/`syncRequest`; falls back to `AGENT_PRIVATE_KEY` |
| `AGENT_ID` | if auto-registering | identity id passed to reviewer registration |
| `AGENT_ENS_NAME` | if auto-registering | ENS name passed to reviewer registration |
| `AGENT_AUTO_REGISTER` | optional | if `true`, agents attempt reviewer registration at boot |
| `DAIO_AUTO_START_REQUESTS` | yes | keep `true` for active production serving |
| `DAIO_START_REQUESTS_MAX_PER_TICK` | yes | max start attempts per polling tick, default `2` |
| `DAIO_START_NEXT_REQUEST_GAS_FLOOR` | optional | keeper `startNextRequest` gas floor, default `300000` |
| `DAIO_SYNC_REQUEST_GAS_FLOOR` | optional | keeper `syncRequest` gas floor, default `2000000` |
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
capacity, VRF eligibility, and contract rules allow it. Set
`DAIO_KEEPER_PRIVATE_KEY` for keeper-enabled agents when keeper gas should be
isolated from reviewer commit/reveal wallets.

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
config from contract storage finality=2 reviewDiff=10000 auditDiff=10000 auditTargetLimit=3
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
  messages: [
    { role: "system", content: "Return only JSON." },
    { role: "user", content: "Return JSON: {\"ok\":true}" }
  ],
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
E2E_QUORUM=4 \
E2E_REQUEST_COUNT=2 \
E2E_MAX_ACTIVE_REQUESTS=2 \
E2E_REVIEW_VRF_DIFFICULTY=10000 \
E2E_AUDIT_VRF_DIFFICULTY=10000 \
E2E_AUDIT_TARGET_LIMIT=3 \
DAIO_REVIEW_COMMIT_GAS_FLOOR=7000000 \
DAIO_REVIEW_REVEAL_GAS_FLOOR=2000000 \
DAIO_AUDIT_COMMIT_GAS_FLOOR=12000000 \
DAIO_AUDIT_REVEAL_GAS_FLOOR=12000000 \
npm run e2e:sepolia-fork
```

That command is a pre-production validation tool. It forks Sepolia locally and
uses `./.deployments/sepolia.json` addresses without replacing deployed contract
code. It is not the production serving process.

The `contracts` submodule also provides a lower-level generated-wallet fork E2E
that talks directly to the deployed Sepolia addresses on a local fork. Use it
after generated reviewer wallets are registered, staked, funded, and registered
with VRF public keys derived from the same wallet private keys. It validates the
deployed payment router, relayed request path, real FRAIN VRF proof generation,
review/audit commits and reveals, finalization, and round-ledger accounting
without starting the off-chain agent containers. If production uses separate
`AGENT_PRIVATE_KEY` and `AGENT_VRF_PRIVATE_KEY` values, prefer the agent-level
`npm run e2e:sepolia-fork` path or adapt the contract helper before relying on
it.

Create a temporary shell-only env file outside version control:

```sh
cat > contracts/.env.generated-wallets-fork <<'EOF'
HARDHAT_FORK_URL=<sepolia-rpc-url>
DAIO_REQUESTER_PRIVATE_KEY=<requester-private-key-with-usdaio-approval>
DAIO_RELAYER_PRIVATE_KEY=<relayer-private-key-with-sepolia-eth>
DAIO_AGENT_1_ADDRESS=<registered-reviewer-1-address>
DAIO_AGENT_1_PRIVATE_KEY=<registered-reviewer-1-private-key>
DAIO_AGENT_2_ADDRESS=<registered-reviewer-2-address>
DAIO_AGENT_2_PRIVATE_KEY=<registered-reviewer-2-private-key>
DAIO_AGENT_3_ADDRESS=<registered-reviewer-3-address>
DAIO_AGENT_3_PRIVATE_KEY=<registered-reviewer-3-private-key>
DAIO_AGENT_4_ADDRESS=<registered-reviewer-4-address>
DAIO_AGENT_4_PRIVATE_KEY=<registered-reviewer-4-private-key>
DAIO_AGENT_5_ADDRESS=<registered-reviewer-5-address>
DAIO_AGENT_5_PRIVATE_KEY=<registered-reviewer-5-private-key>
EOF
chmod 600 contracts/.env.generated-wallets-fork
```

Then run:

```sh
cd contracts
set -a
. ./.env.generated-wallets-fork
set +a
OPTIMIZER_RUNS=10 npx hardhat compile
npx hardhat run scripts/generated-wallets-fork-e2e.js --network hardhat
```

The reliable E2E finalization default is review VRF `10000/10000`, audit VRF
`10000/10000`, quorum `4`, and Fast-tier audit target limit `3`. Lower
sortition probabilities exercise availability behavior, but real VRF may
legitimately miss quorum for a five-agent run. Treat those as
stress/availability scenarios rather than guaranteed success cases.

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

Canonical converted Markdown for third-party agents:

```sh
curl -sS http://127.0.0.1:18002/requests/<requestId>/markdown
curl -sS 'http://127.0.0.1:18002/requests/<requestId>/markdown?format=raw'
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

Browser frontends should call the content API through the same HTTPS origin when
possible. If the frontend is hosted on a different origin, add the required CORS
headers in the reverse proxy or API gateway; the bundled content-service and
MarkItDown containers do not add CORS headers themselves.

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

That update path follows the submodule commits pinned by the parent repository.
When intentionally moving to the latest upstream submodule commits, do it as a
separate change and review the resulting contract delta before deployment:

```sh
git submodule update --remote --recursive
git diff --submodule=log -- contracts tools/markitdown
docker compose config --quiet
docker compose build
```

If the `contracts` pointer changes, re-run Sepolia fork validation and confirm
that `.deployments/sepolia.json` still matches the deployed contract set before
restarting production services.

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
- If the `contracts` submodule was advanced, contract delta was reviewed with
  `git diff --submodule=log -- contracts`.

Environment:

- `.env` created from `.env.example`.
- `.env.agent_1` through `.env.agent_5` created from `.env.agent.example`.
- `.env` permission set to `600`.
- `.env.agent_*` permission set to `600`.
- `RPC_URL` set.
- `RPC_URLS` contains at least two production-grade Sepolia RPC endpoints when possible.
- RPC provider allowlists include the EC2 public IP or NAT egress IP.
- `RPC_FAILOVER_QUORUM=1` unless all configured RPC backends are fast enough for multi-backend agreement.
- `DAIO_DEPLOYMENT_FILE=sepolia.json` set, or `DAIO_DEPLOYMENT_JSON_B64` set.
- `CONTENT_RELAYER_PRIVATE_KEY` set if relayed request creation is enabled.
- `CONTENT_REQUIRE_AGENT_SIGNATURES=true`.
- Each `.env.agent_N` has `RPC_URL`, `LLM_BASE_URL`, `LLM_MODEL`, timeout, max tokens, and char budget set.
- Each `.env.agent_N` has `RPC_URLS` set to that agent operator's allowed RPC fallback list.
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
- Optional generated-wallet Sepolia fork E2E passes after live reviewer wallets
  are registered, staked, funded, and approved for the test flow.

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
