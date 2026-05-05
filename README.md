# DAIO Reviewer Agents

Off-chain reviewer-agent runtime, content service, and end-to-end orchestrator for the [DAIO](https://github.com/openDAIO/contracts) review-consensus protocol.

This repository implements the off-chain side of the contract specified in [REVIEWER_AGENT_INTERFACES.md](REVIEWER_AGENT_INTERFACES.md): independent AI-powered reviewer-agent processes register with the deployed DAIO contracts, evaluate documents, audit each other, and converge on finalized consensus scores.

## What Runs Where

```
                                       ┌────────────────────────────────────┐
                                       │  E2E Orchestrator (npm run e2e)    │
                                       │  - spawns hardhat node             │
                                       │  - deploys or forks DAIO contracts │
                                       │  - spawns content-service          │
                                       │  - spawns 5 agent processes        │
                                       │  - submits request, awaits final   │
                                       └────────┬───────────────────────────┘
                                                │ child_process.spawn
                ┌───────────────────────────────┼──────────────────────────────────┐
                │                               │                                  │
        ┌───────▼────────┐             ┌────────▼─────────┐               ┌────────▼────────┐
        │ hardhat node   │             │ content-service  │               │ reviewer-agent  │ × 5
        │ port 8545      │             │ Fastify+SQLite   │               │ - watches RPC   │
        │ chainId 31337  │             │ port 18002       │               │ - calls LLM     │
        │ DAIO contracts │             │ proposals/       │               │ - signs txs     │
        │   deployed     │             │   reports/audits │               │   commit/reveal │
        └───────▲────────┘             └────────▲─────────┘               └────────┬────────┘
                │ JSON-RPC                      │ HTTP                             │
                └───────────────────────────────┴──────────────────────────────────┘
```

The agent processes are fully independent OS-level processes. They share only the chain (RPC) and the content service (HTTP). No in-memory or filesystem coupling.

## Repository Layout

```
agents/
├── package.json, tsconfig.json, .env(.example), .gitignore
├── REVIEWER_AGENT_INTERFACES.md         # off-chain contract spec
├── contracts/                            # submodule: openDAIO/contracts (Solidity)
├── tools/markitdown/                     # submodule: openDAIO/markitdown (PDF→MD)
├── samples/paper-001.md                  # generated from contracts/BRAIN.pdf
├── scripts/prepare-samples.sh            # one-shot pdf → md
└── src/
    ├── shared/
    │   ├── abis.ts                       # ABI loader (reads contracts/artifacts)
    │   ├── schemas.ts                    # zod for daio.review.output.v1, daio.audit.output.v1
    │   ├── canonical.ts                  # canonical JSON + keccak256
    │   ├── content-client.ts             # HTTP client for content-service
    │   └── types.ts                      # RequestStatus, Tier, sortition phase constants
    ├── content-service/
    │   ├── server.ts                     # Fastify app
    │   ├── db.ts                         # better-sqlite3 schema
    │   └── cli.ts                        # entrypoint
    ├── reviewer-agent/
    │   ├── llm/{client,prompts,prepareInput,validate}.ts
    │   ├── chain/{provider,contracts,vrf,sortition,events,registration}.ts
    │   ├── runtime/{state,reviewFlow,auditFlow,agent}.ts
    │   └── cli.ts                        # entrypoint
    └── e2e/
        ├── deploy.ts                     # programmatic ethers deployment
        ├── hardhat.ts                    # spawn/teardown hardhat node
        ├── sortition-prescreen.ts        # find a passing reviewer committee
        ├── orchestrate.ts                # full E2E driver
        └── cli.ts                        # `npm run e2e` entrypoint
```

## How an E2E Run Goes

1. Orchestrator spawns `npx hardhat node` and waits for the JSON-RPC banner. With `E2E_CHAIN_MODE=sepolia-fork`, it starts Hardhat with `--fork` and attaches to the deployed addresses in `.deployments/sepolia.json`.
2. In local mode, orchestrator deploys the DAIO stack (USDAIO, StakeVault, ReviewerRegistry, AssignmentManager, ConsensusScoring, Settlement, ReputationLedger, DAIOCommitRevealManager, DAIOPriorityQueue, FRAINVRFVerifier, DAIOVRFCoordinator, DAIOCore, payment stack) using ethers v6 + the compiled artifacts under `contracts/artifacts/`. In Sepolia fork mode, it keeps the deployed Sepolia contract code and addresses, then mutates only fork-local state needed for test agents.
3. Orchestrator spawns the content-service with a relayer key and prepares `samples/paper-001.md`. The service computes `keccak256(text)` when it builds the request intent and when it stores the verified document.
4. Orchestrator mints USDAIO and pre-registers candidate reviewers (each with ENS, agent ID, its own derived VRF public key, and enough stake for the active request window). In Sepolia fork mode, it impersonates the deployed owner only inside the fork to disable ENS/ERC8004 reviewer gates and set the Fast tier to the E2E quorum/sortition config.
5. Requester wallet approves the PaymentRouter, asks the content API for `/request-intents/usdaio`, signs the returned EIP-712 payload, and submits `/requests/relayed-document`. The content API calls `createRequestWithUSDAIOBySig(...)`, pays gas from the relayer wallet, stores the document, and leaves the on-chain requester as the requester wallet.
6. Orchestrator pre-screens a five-agent committee by simulating local review sortition at the predicted `phaseStartBlock`, checking quorum 3 under the configured review election difficulty.
7. Five reviewer-agent child processes are spawned, each given its private key, the deployment snapshot, the content-service URL, and a per-agent state directory. They subscribe to chain events.
8. Orchestrator or the agent keeper loop calls `core.startNextRequest()`. The request advances to `ReviewCommit` and a `StatusChanged` event fires.
9. Each agent reads the request's copied runtime config snapshot from DAIOCore storage, then independently runs the `Review` flow defined in [REVIEWER_AGENT_INTERFACES § 5.1](REVIEWER_AGENT_INTERFACES.md#5-end-to-end-runtime-flow): eligibility check → local sortition pre-check → fetch proposal → call LLM with `task=review` → validate → store canonical artifact → `commitReview(...)` → `revealReview(...)`.
10. After the review reveal quorum is met, status advances to `AuditCommit`. Each revealed agent rereads the same request config snapshot and runs the `Audit` flow defined in § 5.2: reconstruct revealed reviewers → audit every revealed peer → fetch target reports → call LLM with `task=audit` → validate → `commitAudit(..., [])` → `revealAudit(...)`.
11. Once the audit reveal quorum is met, the contract runs `ConsensusScoring`, `Settlement`, and `ReputationLedger` in the same transaction. `RequestFinalized` is emitted.
12. Orchestrator listens for `RequestFinalized`, reads round-ledger aggregate/reviewer views plus the content API reason/status endpoints, prints a summary, and tears down the agent processes, content-service, and hardhat node.

## Recorded Run

The data below is captured directly from the working run (`npm run e2e`, May 2026) — the same data that lives in `.data/content.sqlite` and `.state/agent-{2,3}/req-1.json` after the orchestrator finishes.

### Inputs

#### Sample document

`samples/paper-001.md` — generated from [contracts/BRAIN.pdf](contracts/BRAIN.pdf) by `markitdown`. 174,360 bytes (≈ 44k tokens). First lines (the conversion drops some inter-word spaces, which the LLM tolerates):

```
BRAIN: Blockchain-based Inference and Training
Platform for Large-Scale Models
SANGHYEONPARK ,JUNMOLEE ,ANDSOO-MOOKMOON
DepartmentofElectricalandComputerEngineering,SeoulNationalUniversity,Seoul08826,RepublicofKorea

ABSTRACT Asartificialintelligence(AI)isinnovatingvariousindustries,thereareconcernsaboutthetrust
andtransparencyofAI-driveninferenceandtrainingresults. ... we introduce BRAIN, a
Blockchain-basedReliableAINetwork. AuniquefeatureofBRAINisitstwo-phasetransactionexecution
mechanism,whichallowspipelinedprocessingofinferenceortrainingtransactions. ...
```

#### On-chain anchors

| Field | Value |
| --- | --- |
| `proposalURI` | `content://proposals/paper-001` |
| `proposalHash` | `0x48271267013cff731a3a8609192fe561ee69256a449d26794363b5b18a8f6a58` |
| `rubricHash` | `0x2047e2d0856cc3f51b9cf3d7055c2e469d68d58609dafe553151c530a428cb4e` |
| `requestId` | `1` |
| `tier` | `Fast` (current E2E default: review election difficulty 8000/10000, audit election difficulty 10000/10000, quorum 3, audit-target limit 2) |

#### Reviewers chosen

| Label | Address | agentId | ENS |
| --- | --- | --- | --- |
| R1 | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` | 1002 | `reviewer-2.daio.eth` |
| R2 | `0x976EA74026E726554dB657fA54763abd0C3a0aa9` | 1004 | `reviewer-4.daio.eth` |
| R3 | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | 1001 | `reviewer-1.daio.eth` |

### LLM outputs (recorded as stored on the content-service)

#### R3 review artifact (`/reports/0x643abeef…`)

```json
{
  "schema": "daio.review.artifact.v1",
  "requestId": "1",
  "reviewer": "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "proposalScore": 6200,
  "report": {
    "summary": "The paper proposes BRAIN, a blockchain-based platform for inference and training of large AI models using a two-phase transaction pipeline and aggregator-free asynchronous federated learning. It includes extensive design details, algorithms, and experimental evaluation on inference throughput and training convergence.",
    "rubricAssessments": [
      { "criterion": "clarity",                "score": 5400, "rationale": "The manuscript is dense and suffers from formatting issues, making it hard to follow key ideas." },
      { "criterion": "novelty",                "score": 6800, "rationale": "Combining two-phase blockchain transactions with asynchronous FL is a novel integration, though similar concepts exist." },
      { "criterion": "technical_correctness", "score": 6100, "rationale": "Algorithms are described in detail, but some assumptions (e.g., fee model) lack rigorous justification." },
      { "criterion": "evaluation_quality",    "score": 5600, "rationale": "Experiments cover inference throughput and training convergence, yet lack statistical rigor and comparison to strong baselines." },
      { "criterion": "presentation",           "score": 5000, "rationale": "The paper contains numerous typographical errors, broken tables, and unreadable sections that hinder readability." }
    ],
    "strengths": [
      "Innovative two-phase transaction design for pipelined AI workloads.",
      "Aggregator-free FL approach reduces central trust requirements.",
      "Comprehensive system description with smart-contract and VRF integration."
    ],
    "weaknesses": [
      "Poor formatting and numerous typographical errors impair comprehension.",
      "Evaluation lacks thorough baseline comparisons and statistical analysis.",
      "Fee and incentive mechanisms are under-specified and not formally analyzed."
    ],
    "risks": [
      "Scalability may be limited by on-chain verification costs for large models.",
      "Security assumptions rely heavily on VRF randomness without formal proofs."
    ],
    "recommendation": "weak_accept",
    "confidence": 7200
  },
  "source": {
    "proposalURI": "content://proposals/paper-001",
    "proposalHash": "0x48271267013cff731a3a8609192fe561ee69256a449d26794363b5b18a8f6a58",
    "rubricHash":  "0x2047e2d0856cc3f51b9cf3d7055c2e469d68d58609dafe553151c530a428cb4e"
  },
  "metadata": { "createdAt": "2026-05-01T01:44:16.902Z" }
}
```

#### R2 review artifact (`/reports/0x40fe72e4…`)

```json
{
  "schema": "daio.review.artifact.v1",
  "requestId": "1",
  "reviewer": "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "proposalScore": 6500,
  "report": {
    "summary": "The paper proposes BRAIN, a blockchain-based platform for inference and training of large-scale AI models using a two-phase transaction pipeline and asynchronous federated learning. It includes extensive design details, algorithms, and experimental evaluation on inference throughput and training convergence. The work targets compatibility with existing blockchains and aims to improve trust and scalability of AI services.",
    "rubricAssessments": [
      { "criterion": "clarity",                "score": 5500, "rationale": "The manuscript contains many formatting issues and dense technical sections that hinder readability, but the core ideas can be extracted." },
      { "criterion": "novelty",                "score": 7000, "rationale": "Combining two-phase blockchain transactions with asynchronous federated learning for large models is a novel integration of existing concepts." },
      { "criterion": "technical_correctness", "score": 6000, "rationale": "The algorithms are described in detail, yet some assumptions (e.g., security guarantees) lack rigorous proofs." },
      { "criterion": "evaluation_quality",    "score": 5800, "rationale": "Experiments cover inference throughput and training convergence, but lack comparison to strong baselines and real-world deployment metrics." },
      { "criterion": "presentation",           "score": 5200, "rationale": "The paper suffers from poor formatting, missing figures, and inconsistent notation, reducing overall presentation quality." }
    ],
    "strengths": [
      "Innovative combination of blockchain transaction pipelining with asynchronous FL.",
      "Comprehensive system design covering inference, training, and incentive mechanisms.",
      "Extensive experimental analysis of throughput, timeouts, and Byzantine robustness."
    ],
    "weaknesses": [
      "Manuscript formatting and typographical errors impede comprehension.",
      "Limited quantitative comparison with state-of-the-art decentralized AI solutions.",
      "Security analysis is informal and does not provide formal guarantees."
    ],
    "risks": [
      "Potential scalability bottlenecks when deployed on high-throughput public blockchains.",
      "Risk of insufficient incentive alignment without a detailed economic model."
    ],
    "recommendation": "weak_accept",
    "confidence": 7500
  },
  "source": {
    "proposalURI": "content://proposals/paper-001",
    "proposalHash": "0x48271267013cff731a3a8609192fe561ee69256a449d26794363b5b18a8f6a58",
    "rubricHash":  "0x2047e2d0856cc3f51b9cf3d7055c2e469d68d58609dafe553151c530a428cb4e"
  },
  "metadata": { "createdAt": "2026-05-01T01:44:18.440Z" }
}
```

#### Audit scores (recorded on-chain via `revealAudit`)

| Auditor | Target | Score |
| --- | --- | ---: |
| R2 (`0x976E…`) | R3 (`0x90F7…`) | **8600** |
| R3 (`0x90F7…`) | R2 (`0x976E…`) | **8500** |

Each revealed agent audited every other revealed reviewer. Audit rationales are off-chain runtime artifacts and were not stored in this run because the current contracts do not anchor audit URIs.

### Transactions

| Step | Tx |
| --- | --- |
| Requester `createRequestWithUSDAIO` | `0x285ba59a7d69f81863aceeaaf63fa51a90bae5755f95e8090e79efc97178c2c9` |
| Orchestrator `core.startNextRequest()` | `0xeed1ff67a549c64ccf79fe7b6a82d1c74e6119a140af99604d36183b7fcee706` (block 63) |
| R3 `commitReview` | `0xb85c7ad4806eb2b454e4b399519ae08c00d5c3caa80570c70a60782c46c23bbf` |
| R2 `commitReview` | `0x0ed6b32943960c6669cb6e8ed4fd6960547d012a7498a95b677951fa1998755b` |
| R3 `revealReview` | `0x16dd30c1a64aba1a806ae3d107edf16e76caf9e4719217d8c7d87c56198fb05a` |
| R2 `revealReview` | `0x7e684120fce2ab65938d7a6bde9a9534954fc6f64a45aa8267686b0debcc8f85` |
| R2 `commitAudit` | `0x2370856ad808ab9243c22ab770016444a6b69de1c936bb053d09de0839ef4601` |
| R3 `commitAudit` | `0x3eeb2b4832ea9f94614b157d4577d32fd5ac43a56f291bb2cfa476adfda55446` |
| R2 `revealAudit` | `0x127340f6ca9626c7ffe09ec3b3f2d757d1f5203c50f306c905fe26a746ea2c8e` |
| R3 `revealAudit` | `0x7cc655d2841bbcd5b9b61e4759235fe31feb066a4ab8801d77c4d716eb7ae516` |

### On-chain results

`getRequestFinalResult(1)`:

| Field | Value |
| --- | ---: |
| `status` | `6` (`Finalized`) |
| `finalProposalScore` | **6200 / 10000** |
| `confidence` | **9850 / 10000** |
| `auditCoverage` | **10000** (100 %) |
| `scoreDispersion` | `150` |
| `finalReliability` | `9850` |
| `lowConfidence` | `false` |
| `faultSignal` | `0` |

`getReviewerResult(1, addr)`:

| Reviewer | reportQualityMedian | normReportQuality | normAuditReliability | finalContribution | reward (USDAIO) | covered | fault |
| --- | ---: | ---: | ---: | ---: | ---: | :-: | :-: |
| R1 (`0x15d3…`) | 0 | 0 | 0 | 0 | 0 | false | false |
| R2 (`0x976E…`) | 8500 | 9883 | 10000 | **9883** | **44.7352…** | true | false |
| R3 (`0x90F7…`) | 8600 | 10000 | 10000 | **10000** | **45.2647…** | true | false |

In the recorded legacy run, R1 was excluded by VRF sortition and the protocol still finalized with the configured quorum. Current E2E runs use five spawned agents, Fast-tier quorum 3, review difficulty 8000/10000, full-audit difficulty 10000/10000, and audit target limit 2.

### Verbatim orchestrator stdout

```
[orchestrate] starting E2E
[orchestrate] hardhat ready at http://127.0.0.1:8545
[orchestrate] deployment written to .deployments/local.json
[orchestrate] content-service ready at http://127.0.0.1:18002
[orchestrate] proposal uploaded: content://proposals/paper-001 hash=0x48271267013cff731a3a8609192fe561ee69256a449d26794363b5b18a8f6a58 bytes=174360
[orchestrate] registered 10 reviewers
[orchestrate] createRequest tx=0x285ba59a7d69f81863aceeaaf63fa51a90bae5755f95e8090e79efc97178c2c9
[orchestrate] prescreen triple: 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65, 0x976EA74026E726554dB657fA54763abd0C3a0aa9, 0x90F79bf6EB2c4f870365E785982E1f101E93b906
[orchestrate] spawned agent R1 for 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
[orchestrate] spawned agent R2 for 0x976EA74026E726554dB657fA54763abd0C3a0aa9
[orchestrate] spawned agent R3 for 0x90F79bf6EB2c4f870365E785982E1f101E93b906
[agent R1 0x15d34AAf] started; watching events
[agent R2 0x976EA740] started; watching events
[agent R3 0x90F79bf6] started; watching events
[orchestrate] startNextRequest tx=0xeed1ff67a549c64ccf79fe7b6a82d1c74e6119a140af99604d36183b7fcee706 block=63
[agent R1 0x15d34AAf] review: sortition NOT passed for request 1, skip
[agent R3 0x90F79bf6] review: sortition passed; running review for request 1
[agent R2 0x976EA740] review: sortition passed; running review for request 1
[agent R3 0x90F79bf6] review: LLM ok (30826ms, 51365 tokens)
[agent R3 0x90F79bf6] review: committed (tx=0xb85c7ad4806eb2b454e4b399519ae08c00d5c3caa80570c70a60782c46c23bbf)
[agent R2 0x976EA740] review: LLM ok (32363ms, 51399 tokens)
[agent R2 0x976EA740] review: committed (tx=0x0ed6b32943960c6669cb6e8ed4fd6960547d012a7498a95b677951fa1998755b)
[agent R3 0x90F79bf6] review: revealed (tx=0x16dd30c1a64aba1a806ae3d107edf16e76caf9e4719217d8c7d87c56198fb05a)
[agent R2 0x976EA740] review: revealed (tx=0x7e684120fce2ab65938d7a6bde9a9534954fc6f64a45aa8267686b0debcc8f85)
[agent R2 0x976EA740] audit: canonical targets = [0x90F79bf6EB2c4f870365E785982E1f101E93b906]
[agent R3 0x90F79bf6] audit: canonical targets = [0x976EA74026E726554dB657fA54763abd0C3a0aa9]
[agent R2 0x976EA740] audit: LLM ok (83037ms, 51432 tokens)
[agent R2 0x976EA740] audit: committed (tx=0x2370856ad808ab9243c22ab770016444a6b69de1c936bb053d09de0839ef4601)
[agent R3 0x90F79bf6] audit: LLM ok (85470ms, 51520 tokens)
[agent R3 0x90F79bf6] audit: committed (tx=0x3eeb2b4832ea9f94614b157d4577d32fd5ac43a56f291bb2cfa476adfda55446)
[agent R2 0x976EA740] audit: revealed (tx=0x127340f6ca9626c7ffe09ec3b3f2d757d1f5203c50f306c905fe26a746ea2c8e)
[agent R3 0x90F79bf6] audit: revealed (tx=0x7cc655d2841bbcd5b9b61e4759235fe31feb066a4ab8801d77c4d716eb7ae516)
[orchestrate] RequestFinalized requestId=1 finalProposalScore=6200 confidence=9850
[orchestrate] final result: {"status":6,"finalProposalScore":"6200","confidence":"9850","auditCoverage":"10000","scoreDispersion":"150","finalReliability":"9850","lowConfidence":false,"faultSignal":"0"}
[orchestrate] reviewer 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65: reportQualityMedian=0 normalizedReportQuality=0 normalizedAuditReliability=0 finalContribution=0 reward=0 covered=false fault=false
[orchestrate] reviewer 0x976EA74026E726554dB657fA54763abd0C3a0aa9: reportQualityMedian=8500 normalizedReportQuality=9883 normalizedAuditReliability=10000 finalContribution=9883 reward=44735200925413669969 covered=true fault=false
[orchestrate] reviewer 0x90F79bf6EB2c4f870365E785982E1f101E93b906: reportQualityMedian=8600 normalizedReportQuality=10000 normalizedAuditReliability=10000 finalContribution=10000 reward=45264799074586330030 covered=true fault=false
[orchestrate] cleaning up
[orchestrate] DONE ok=true score=6200 confidence=9850
```

End-to-end wall-clock: ~ 4 minutes (deployment ≈ 10 s, reviewer registration ≈ 5 s, two parallel review-LLM calls ≈ 30 s each, two parallel audit-LLM calls ≈ 85 s each, settlement ≈ 1 s).

## How to Run

One-time setup:

```bash
git submodule update --init --recursive
npm install
(cd contracts && npm install && npx hardhat compile)
bash scripts/prepare-samples.sh    # converts contracts/BRAIN.pdf → samples/paper-001.md
```

Local E2E/content-service `.env` values:

```bash
RPC_URL=https://sepolia.drpc.org
RPC_URLS=https://sepolia.drpc.org,https://ethereum-sepolia-rpc.publicnode.com
RPC_FAILOVER_STALL_TIMEOUT_MS=750
RPC_FAILOVER_QUORUM=1
RPC_FAILOVER_EVENT_QUORUM=1
RPC_BATCH_MAX_COUNT=1
RPC_READ_RETRIES=3
RPC_READ_RETRY_BASE_MS=500
RPC_TX_WAIT_RETRIES=5
RPC_TX_WAIT_RETRY_BASE_MS=1000
DAIO_TX_FINALITY_CONFIRMATIONS=1
DAIO_TX_FINALITY_WAIT_TIMEOUT_MS=300000
DAIO_DEPLOYMENT_FILE=sepolia.json

OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini-2026-03-17
# Optional proxy/gateway override. Defaults to https://api.openai.com/v1 when OPENAI_API_KEY is set.
# OPENAI_BASE_URL=https://api.openai.com/v1
# Optional override. By default the runtime derives a stable key from the shared prompt prefix.
# OPENAI_PROMPT_CACHE_KEY=
OPENAI_PROMPT_CACHE_RETENTION=24h
LLM_BASE_URL=
LLM_MODEL=
LLM_TIMEOUT_MS=120000
LLM_MAX_TOKENS=8192
LLM_REASONING_EFFORT=low
LLM_PROPOSAL_CHAR_BUDGET=350000
LLM_RESPONSE_CACHE_TTL_SECONDS=0
LLM_RESPONSE_CACHE_MAX_ENTRIES=4096
LLM_RESPONSE_CACHE_DB_PATH=

CONTENT_SERVICE_PORT=18002
CONTENT_SERVICE_HOST=127.0.0.1
CONTENT_DB_PATH=./.data/content.sqlite
CONTENT_REQUIRE_AGENT_SIGNATURES=true
CONTENT_RELAYER_CONFIRMATIONS=1

CORS_ALLOW_ORIGIN=*
CORS_ALLOW_METHODS=GET,POST,PUT,PATCH,DELETE,OPTIONS
CORS_ALLOW_HEADERS=Content-Type,Authorization,X-Requested-With,X-Filename
CORS_EXPOSE_HEADERS=Content-Length,Content-Type
CORS_MAX_AGE=86400
CORS_ALLOW_CREDENTIALS=false
```

`RPC_URL` is the primary endpoint. `RPC_URLS` can add comma- or space-separated
fallback endpoints; duplicate entries are ignored. Agents and the content
service use an ethers `FallbackProvider` when more than one endpoint is
configured. The default quorum is `1`, which favors availability for Sepolia
operations; raise `RPC_FAILOVER_QUORUM` only when every configured endpoint is
fast and independently reliable enough for multi-backend agreement.
`RPC_BATCH_MAX_COUNT=1` disables ethers JSON-RPC batching, which avoids public
RPC providers that reject large batches. `RPC_READ_RETRIES` and
`RPC_READ_RETRY_BASE_MS` add short exponential-backoff retries around event
polling and chain reads. `RPC_TX_WAIT_RETRIES` and
`RPC_TX_WAIT_RETRY_BASE_MS` add retries while waiting for transaction receipts.
Retryable provider-side failures such as public-RPC `408`, `429`, and transient
network errors are logged and retried instead of crashing the agent process;
non-retryable unhandled failures still terminate the process so Docker can
restart it cleanly. For production load, keep at least two unique RPC endpoints
configured and prefer paid/dedicated Sepolia RPCs over free public tiers.
`CORS_ALLOW_ORIGIN=*` makes both content-service and MarkItDown respond to
browser preflight requests on every endpoint. For a locked-down frontend, replace
it with a comma-separated allowlist such as `http://localhost:3000,https://app.example`.

Production agents also wait for direct-call documents instead of failing the
round immediately:

```bash
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
DAIO_KEEPER_PRIVATE_KEY=
DAIO_START_NEXT_REQUEST_GAS_FLOOR=300000
DAIO_SYNC_REQUEST_GAS_FLOOR=2000000
```

When the agent can read DAIOCore's on-chain request config, missing-document
waits fill the live active phase instead of stopping early:
`phaseTimeout - elapsedPhaseTime`. `DAIO_DOCUMENT_WAIT_MS` is used only when the
phase timeout cannot be read. If a document appears very late,
`DAIO_MIN_COMMIT_TIME_REMAINING_MS` prevents the agent from starting LLM/commit
work that is unlikely to land before the commit window closes; before the phase
times out, the request remains `waiting_document` rather than being marked
`document_unavailable`.

Docker Compose enables keeper duties only on `agent-1` by default. Override
`DAIO_KEEPER_ENABLED_AGENT_N=true|false` in `.env` if a different agent should
own `startNextRequest`. Set `DAIO_KEEPER_PRIVATE_KEY` in `.env` or in the
keeper-enabled agent env to use a dedicated funded gas wallet for keeper-only
`startNextRequest` and `syncRequest` transactions. Review/audit commit-reveal
transactions still use each `AGENT_PRIVATE_KEY`, because the reviewer address
must be the transaction sender. The keeper also probes active requests with
`syncRequest.staticCall(...)` and sends a real `syncRequest` transaction only
when the contract would advance the request, for example after a protocol
timeout. Keeper gas floors add headroom above fragile RPC gas estimates; unused
gas is not spent. Keeper active sync is de-duped per request while a sync is
already in flight, which avoids redundant `syncRequest` transactions during
reconcile ticks or event replay.

For `maxActiveRequests=2`, each reviewer wallet should have at least
`2 * ReviewerRegistry.minStake()` staked. Otherwise one active request can lock
the wallet's available stake and make that reviewer ineligible for the next
concurrent active request. The agent registration helper no longer uses an
identityless stake top-up fallback, so it will not clear on-chain ENS/ERC8004
identity fields to add stake.
Set `DAIO_AGENT_TARGET_STAKE_USDAIO=6000` in each `.env.agent_N` for a wider
Sepolia buffer. If the configured ENS name does not resolve to the reviewer or
ERC-8004 agent wallet, set `DAIO_REGISTER_ENS=false`; ERC-8004 `agentId` can
still be registered without clearing identity fields.

For live Sepolia testing, keep reviewer wallets funded with about `0.05 ETH`
each for commit-reveal gas and keep the dedicated keeper and content relayer
wallets around `0.05 ETH` each. The requester needs USDAIO balance and
`PaymentRouter` allowance for `baseRequestFee + priorityFee` per request; the
relayer only pays gas for relayed requests and does not pay the protocol fee.

Run the full E2E:

```bash
npm run e2e
```

Run the deployed-contract Sepolia fork E2E:

```bash
RPC_URL=https://sepolia.drpc.org \
E2E_AGENT_COUNT=5 \
E2E_QUORUM=3 \
E2E_REQUEST_COUNT=2 \
E2E_MAX_ACTIVE_REQUESTS=2 \
E2E_REVIEW_VRF_DIFFICULTY=8000 \
E2E_AUDIT_VRF_DIFFICULTY=10000 \
E2E_AUDIT_TARGET_LIMIT=2 \
DAIO_REVIEW_COMMIT_GAS_FLOOR=7000000 \
DAIO_REVIEW_REVEAL_GAS_FLOOR=2000000 \
DAIO_AUDIT_COMMIT_GAS_FLOOR=12000000 \
DAIO_AUDIT_REVEAL_GAS_FLOOR=12000000 \
npm run e2e:sepolia-fork
```

Run a live Sepolia PDF smoke/E2E against already running content-service and
MarkItDown:

```bash
DAIO_REQUESTER_PRIVATE_KEY=<funded-requester-key> \
CONTENT_SERVICE_URL=http://127.0.0.1:18002 \
MARKITDOWN_URL=http://127.0.0.1:18003 \
npm run ops:e2e:sepolia -- --mode relayed --pdf samples/2505.04223v1.pdf

DAIO_REQUESTER_PRIVATE_KEY=<funded-requester-key> \
npm run ops:e2e:sepolia -- --mode direct --pdf samples/2505.04223v1.pdf --manual-start
```

Use `GET /requests/:requestId/chain-status` on content-service to read the
current on-chain lifecycle even if local agent status rows are still catching
up after restart.

Live Sepolia validation on 2026-05-02 with `samples/2505.04223v1.pdf` finalized
five tracked requests in 11.86 minutes while other users were also testing the
shared queue. The run observed `maxActiveRequests=2` in practice: requests 19
and 20 were active concurrently and finalized together; a follow-up relayed
smoke request, request 22, also finalized with `retryCount=0` and
`lowConfidence=false`. Shared-queue timings include external request pressure,
so use per-request first-active-to-finalized timings when benchmarking agent
throughput.

Live Sepolia validation on 2026-05-03 with `contracts/BlockFlow.pdf` finalized
request 13 through the production Docker stack with RPC failover enabled. The
request ended `Finalized` with `retryCount=0`, `lowConfidence=false`, and final
round aggregates of score `6200` for review, audit consensus, and reputation.
The same run exercised the agent Q&A APIs during `ReviewCommit`, after review
artifact storage, and after finalization. See
[docs/frontend-reference.md](docs/frontend-reference.md#post-requestsrequestidagentsagentask)
for the Q&A request/response spec and real response excerpts. The finalized
score-report and final-report APIs are documented next to it in the same
frontend reference.

Live Sepolia validation on 2026-05-03 after the ConsensusScoring update
finalized relayed request 18 with `contracts/BlockFlow.pdf`. The request ended
`Finalized`, `retryCount=0`, `lowConfidence=false`, final score `6200`,
confidence `10000`, and audit coverage `10000`. The run exercised
`/ask`, `/qa-history`, `/reasons`, per-agent `/score-report`, and
`/final-report`. The finalized report tracked all five agent status rows but
counted only the three on-chain accepted reviewers/auditors as scoring agents;
late off-chain artifacts from non-accepted agents were reported as `skipped`
with `scoreGiven=null`.

The `contracts` submodule also includes deployment and validation helpers for
operators. `contracts/scripts/deploy-via-deployer.js` deploys a new DAIO system
through `DAIOSystemDeployer` when intentionally moving to a new contract set.
`contracts/scripts/generated-wallets-fork-e2e.js` validates the already deployed
Sepolia addresses on a local fork using generated reviewer wallet keys as both
transaction keys and VRF keys, relayed USDAIO requests, real FRAIN VRF proofs,
and round-ledger finalization. The Docker serving path still uses
`.deployments/sepolia.json`; after any new contract deployment, update that
snapshot before starting agents. The current Sepolia snapshot uses
`ConsensusScoring` `0xe271d90C72D9a8D931f337C144C6C4e204F994ed` and records the
previous `0xEf348E9658087F7F459dE35207EF02bEb6923aaE` under
`previousConsensusScoring`.

For an EC2 production-style Sepolia boot with Docker Compose, use
[docs/sepolia-ec2-production.md](docs/sepolia-ec2-production.md). After cloning
the repo and copying `.env` plus `.env.agent_1` through `.env.agent_5`, the
single command is:

```bash
bash scripts/ops/start-sepolia-stack.sh
```

Optional fork controls:

```bash
E2E_SEPOLIA_FORK_BLOCK=10769290
E2E_SEPOLIA_DEPLOYMENT_PATH=.deployments/sepolia.json
E2E_FORK_DISABLE_IDENTITY_MODULES=true
E2E_FORK_CONFIGURE_FAST_TIER=true
E2E_HARDHAT_SILENT=true
```

Standalone binaries (for debugging):

```bash
npm run content-service                   # content-service alone
npm run agent -- --rpc … --privkey … …    # reviewer-agent alone
npm run typecheck                         # tsc --noEmit
```

Production-style Docker Compose setup is documented in [DOCKER.md](DOCKER.md). The included compose file can run the content API, five reviewer agents, and a MarkItDown conversion API on one host for operational convenience. Agent secrets are split into `.env.agent_1` through `.env.agent_5`; independent operators should run their own host/account/env rather than sharing one host-level trust boundary.

Manual probes during a run:

```bash
curl http://127.0.0.1:18002/health
curl http://127.0.0.1:18002/proposals/paper-001
curl http://127.0.0.1:18002/reports/0x643abeef31189c116d28ed73e4d9162355b4ecddd715a389b512fb4f31779238
curl -H 'Content-Type: application/json' \
  -d '{"question":"Summarize your current request context."}' \
  http://127.0.0.1:18002/requests/18/agents/0x66ff396457F3df77c6d520f0f3BBb05e4794E057/ask
curl -X POST \
  http://127.0.0.1:18002/requests/18/agents/0x66ff396457F3df77c6d520f0f3BBb05e4794E057/score-report
curl -X POST http://127.0.0.1:18002/requests/18/final-report
```

## Implementation Notes

### LLM (OpenAI GPT API, OpenAI-compatible fallback)

When `OPENAI_API_KEY` is set, the agent client uses the OpenAI API at
`https://api.openai.com/v1/chat/completions`, sends Bearer authentication, and
prefers `OPENAI_MODEL`. If no OpenAI key is configured, it falls back to
`LLM_BASE_URL` and `LLM_MODEL` for local or compatible endpoints. The client
requests JSON mode, uses `max_completion_tokens` for OpenAI and `max_tokens` for
compatible endpoints, and keeps `reasoning_effort=low` by default so final JSON
has room in the completion budget. For OpenAI calls, the client also sends a
stable `prompt_cache_key` derived from the shared system prompt prefix and uses
`OPENAI_PROMPT_CACHE_RETENTION` when set; the bundled env examples set it to
`24h`. OpenAI cache hits are surfaced as `promptCachedTokens` in immediate usage
objects and in agent LLM completion status payloads.

### VRF and sortition

Both local and Sepolia fork E2E runs use `DAIOVRFCoordinator` + `FRAINVRFVerifier`, not `MockVRFCoordinator`. Each spawned E2E agent receives its own secp256k1 VRF private key; the runtime derives the public key for registration and generates request/phase/epoch-specific VRF proofs before review commits.

The legacy fixture VRF path is disabled unless `DAIO_ALLOW_FIXTURE_VRF=true` is set explicitly. Production and Sepolia fork runs should keep it disabled and provide `AGENT_VRF_PRIVATE_KEY`.

The orchestrator's prescreen routine uses the same DAIO VRF message builder as the agents and verifies generated proofs through the deployed `FRAINVRFVerifier.randomnessFromProof(...)`. This avoids relying on coordinator state while choosing a five-agent committee for a predicted review `phaseStartBlock`. Audit target sortition is disabled in the current full-audit contracts: every reviewer who reveals must audit every other revealed reviewer, and agents send audit commits with an empty target-proof array.

For the current five-agent, quorum-three E2E, `reviewDiff=8000`, `auditDiff=10000`, and `auditTargetLimit=2` are the reliable validation defaults. Lower-probability stress runs exercise review VRF availability behavior, but they can legitimately miss quorum under real sortition and should not be treated as guaranteed finalization tests.

The current `ConsensusScoring` module also treats the "no incoming audits"
case explicitly: when peers fail to audit a reviewer, that reviewer can still
receive contribution weight from normalized audit reliability if they completed
their own audit obligations. A reviewer with neither incoming audits nor audit
work remains at zero contribution.

### Content service as the canonical store

The content-service holds two kinds of artifact: `proposals` (the converted Markdown document under review, addressed by id) and `reports` (review artifacts, addressed by hash). Third-party reviewers can fetch the canonical request document through `GET /requests/:requestId/markdown`; the returned hash is the same Markdown `keccak256` stored on-chain as `proposalHash`. Its `POST /reports` endpoint canonicalizes the artifact (sorted keys + UTF-8) and recomputes `keccak256` server-side, so a report URI is structurally `content://reports/0x<hash>` where the hash matches what the on-chain `ReviewRevealed` event will carry. Audit-time hash verification against `reportHash` is therefore exact.

Agent-written observability data is signed by the agent wallet when `CONTENT_REQUIRE_AGENT_SIGNATURES=true` (the production default). `POST /reports`, `POST /audits`, and `PUT /agent-status` reject unsigned or mismatched writes so another HTTP caller cannot impersonate a reviewer in the status/reason API. Agent Q&A and finalized report generation are read-only/public in the current profile and use the persisted document, chain lifecycle, status events, final artifacts, and recent Q&A history; raw hidden chain-of-thought remains unavailable.

For requester UX, the content-service also exposes a relayed USDAIO flow:

- `POST /request-intents/usdaio` returns the exact EIP-712 `RequestIntent` payload for `PaymentRouter.createRequestWithUSDAIOBySig(...)`.
- `POST /requests/relayed-document` accepts the requester signature and document, preflights `createRequestWithUSDAIOBySig(...)` with `staticCall`, sends the relayed transaction with `CONTENT_RELAYER_PRIVATE_KEY`, verifies the emitted `RequestPaid` event and lifecycle requester, then stores the document. If preflight fails because the requester nonce, allowance, deadline, or signature is stale, the relayer does not send a transaction; the client should request a fresh intent and signature.
- `POST /requests/document-from-tx` recovers document storage from a successful payment transaction hash if the original relayed response was missed.

The requester still pays the protocol fee from their own USDAIO balance through `PaymentRouter` allowance; the relayer only pays gas.

For frontend-facing HTTP endpoints and on-chain view calls, use
[docs/frontend-reference.md](docs/frontend-reference.md) as the integration
contract. It also records which endpoints are requester-facing, third-party
reviewer-facing, or agent/internal.

### Event ordering

The agent's chain-event poller in [src/reviewer-agent/chain/events.ts](src/reviewer-agent/chain/events.ts) merges `StatusChanged`, `ReviewRevealed`, and `RequestFinalized` log batches into a single chronological stream sorted by `(blockNumber, logIndex)` before emitting. This is important because a `ReviewRevealed` and the subsequent `StatusChanged(AuditCommit)` can land in the same transaction (the contract calls `_advance` immediately after `emit ReviewRevealed`); without chronological merging, an `AuditCommit` listener can fire before the matching `ReviewRevealed` is recorded into the agent's local state, causing the auditor to skip itself.

### Nonce management

`ethers v6` `Wallet.sendTransaction(...)` fetches the current pending nonce on each call. Under rapid sequential transactions on hardhat, a stale nonce can be reused. All wallets in the orchestrator and registration helper that issue more than one transaction in a row are wrapped in `NonceManager`, which tracks sent nonces locally.

### Off-chain layering

The agent code is split along the boundaries described in `REVIEWER_AGENT_INTERFACES § 1`:

- `llm/` — produces and validates structured semantic outputs only. Never sees private keys, transaction calldata, seeds, or VRF secret material.
- `chain/` — owns provider, signer, contract handles, VRF inputs, sortition pre-checks, and event indexing.
- `runtime/` — owns canonical artifact construction, seed generation, encrypted state persistence, and the dispatch from chain events into review/audit flows.

State (`src/reviewer-agent/runtime/state.ts`) writes per-request JSON files to a per-agent directory. Seeds are encrypted at rest with ChaCha20-Poly1305 keyed on the container-local `AGENT_STATE_KEY`. Production Docker Compose loads that key from the corresponding `.env.agent_N` file; the E2E orchestrator generates ephemeral state keys for its child processes.

`AGENT_PRIVATE_KEY`, `AGENT_VRF_PRIVATE_KEY`, and `AGENT_STATE_KEY` are all 32-byte secret values, but they protect different domains: transaction authority, sortition proofs, and local commit-reveal seed encryption. A single value may satisfy the parser in a disposable test, but production deployments should use distinct values per agent and per purpose. The content-service relayer, when enabled, adds one more hot-wallet secret: `CONTENT_RELAYER_PRIVATE_KEY`. A keeper-enabled deployment can also set `DAIO_KEEPER_PRIVATE_KEY` so keeper gas spending is isolated from reviewer commit/reveal wallets.

## Known Limitations

- The Sepolia fork E2E mutates fork-local state to register local test reviewers and set a deterministic Fast-tier E2E config. It does not send transactions to Sepolia and does not replace deployed contract code.
- `phaseStartBlock` prediction in the prescreen is best-effort; if the actual block diverges, agents fall back to runtime review sortition checks. The E2E prescreen chooses five agents for quorum 3 under the current full-audit profile; audit target sortition is disabled.
- The `markitdown` PDF → markdown conversion can drop spaces between words in dense academic PDFs (BRAIN paper exhibits this). The LLM tolerates it but a higher-fidelity converter would improve report quality.
- Some compatible JSON-mode models occasionally produce extra whitespace or
  markdown fences; the client trims and accepts ```json fences as a safety net
  even though `response_format=json_object` is requested.

## References

- [REVIEWER_AGENT_INTERFACES.md](REVIEWER_AGENT_INTERFACES.md) — off-chain contract spec
- [contracts/PROPOSAL.md](contracts/PROPOSAL.md) — protocol design
- [contracts/BRAIN.pdf](contracts/BRAIN.pdf) — BRAIN paper (used as the sample document)
- [contracts/BlockFlow.pdf](contracts/BlockFlow.pdf) — BlockFlow paper (basis for consensus scoring)
