# DAIO Reviewer Agents

Off-chain reviewer-agent runtime, content service, and end-to-end orchestrator for the [DAIO](https://github.com/openDAIO/contracts) review-consensus protocol.

This repository implements the off-chain side of the contract specified in [REVIEWER_AGENT_INTERFACES.md](REVIEWER_AGENT_INTERFACES.md): independent AI-powered reviewer-agent processes register with the deployed DAIO contracts, evaluate documents, audit each other, and converge on finalized consensus scores.

## What Runs Where

```
                                       ┌────────────────────────────────────┐
                                       │  E2E Orchestrator (npm run e2e)    │
                                       │  - spawns hardhat node             │
                                       │  - deploys DAIO contracts          │
                                       │  - spawns content-service          │
                                       │  - spawns 3 agent processes        │
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
        ├── sortition-prescreen.ts        # find a passing reviewer triple
        ├── orchestrate.ts                # full E2E driver
        └── cli.ts                        # `npm run e2e` entrypoint
```

## How an E2E Run Goes

1. Orchestrator spawns `npx hardhat node` and waits for the JSON-RPC banner.
2. Orchestrator deploys the DAIO stack (USDAIO, StakeVault, ReviewerRegistry, AssignmentManager, ConsensusScoring, Settlement, ReputationLedger, DAIOCommitRevealManager, DAIOPriorityQueue, FRAINVRFVerifier, MockVRFCoordinator, DAIOCore, payment stack) using ethers v6 + the compiled artifacts under `contracts/artifacts/`. Tier configs (Fast/Standard/Critical) match the reference fixture.
3. Orchestrator spawns the content-service with a relayer key and prepares `samples/paper-001.md`. The service computes `keccak256(text)` when it builds the request intent and when it stores the verified document.
4. Orchestrator mints USDAIO and pre-registers candidate reviewers (each with ENS, agent ID, the shared mock VRF public key, and enough stake for the active request window).
5. Requester wallet approves the PaymentRouter, asks the content API for `/request-intents/usdaio`, signs the returned EIP-712 payload, and submits `/requests/relayed-document`. The content API calls `createRequestWithUSDAIOBySig(...)`, pays gas from the relayer wallet, stores the document, and leaves the on-chain requester as the requester wallet.
6. Orchestrator pre-screens a five-agent committee by simulating local sortition at the predicted `phaseStartBlock`, checking quorum 3 under the configured review/audit election difficulties.
7. Five reviewer-agent child processes are spawned, each given its private key, the deployment snapshot, the content-service URL, and a per-agent state directory. They subscribe to chain events.
8. Orchestrator or the agent keeper loop calls `core.startNextRequest()`. The request advances to `ReviewCommit` and a `StatusChanged` event fires.
9. Each agent reads the request's copied runtime config snapshot from DAIOCore storage, then independently runs the `Review` flow defined in [REVIEWER_AGENT_INTERFACES § 5.1](REVIEWER_AGENT_INTERFACES.md#5-end-to-end-runtime-flow): eligibility check → local sortition pre-check → fetch proposal → call LLM with `task=review` → validate → store canonical artifact → `commitReview(...)` → `revealReview(...)`.
10. After the review reveal quorum is met, status advances to `AuditCommit`. Each revealed agent rereads the same request config snapshot and runs the `Audit` flow defined in § 5.2: reconstruct revealed reviewers → preflight `AssignmentManager.verifiedCanonicalAuditTargets(...)` → fetch target reports → call LLM with `task=audit` → validate → `commitAudit(...)` → `revealAudit(...)`.
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

Each agent only audited the canonical target returned by `AssignmentManager.verifiedCanonicalAuditTargets(...)`. Audit rationales are off-chain runtime artifacts and were not stored in this run because the current contracts do not anchor audit URIs.

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

In the recorded legacy run, R1 was excluded by VRF sortition and the protocol still finalized with the configured quorum. Current E2E runs use five spawned agents, quorum 3, review difficulty 8000/10000, and audit difficulty 10000/10000.

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

`.env` (a working default is committed):

```bash
LLM_BASE_URL=http://59.12.201.156:18001/v1
LLM_MODEL=gpt-oss-120b
LLM_TIMEOUT_MS=120000
LLM_MAX_TOKENS=8192
LLM_REASONING_EFFORT=low
LLM_PROPOSAL_CHAR_BUDGET=350000

CONTENT_SERVICE_PORT=18002
CONTENT_SERVICE_HOST=127.0.0.1
CONTENT_DB_PATH=./.data/content.sqlite

HARDHAT_PORT=8545
HARDHAT_HOST=127.0.0.1
```

Run the full E2E:

```bash
npm run e2e
```

Standalone binaries (for debugging):

```bash
npm run content-service                   # content-service alone
npm run agent -- --rpc … --privkey … …    # reviewer-agent alone
npm run typecheck                         # tsc --noEmit
```

Production-style Docker Compose setup is documented in [DOCKER.md](DOCKER.md). It runs the content API, five reviewer agents, and a MarkItDown conversion API from one `.env`.

Manual probes during a run:

```bash
curl http://127.0.0.1:18002/health
curl http://127.0.0.1:18002/proposals/paper-001
curl http://127.0.0.1:18002/reports/0x643abeef31189c116d28ed73e4d9162355b4ecddd715a389b512fb4f31779238
```

## Implementation Notes

### LLM (`gpt-oss-120b`, vLLM, OpenAI-compatible)

`gpt-oss` models emit `reasoning_content` (chain of thought) before `content` in the same response. With `reasoning_effort=medium` (the model default) and a tight `max_tokens`, the budget is exhausted by the CoT and `content` comes back `null` with `finish_reason=length`. The agent client therefore sets `reasoning_effort=low` and `max_tokens=8192` by default. With these two, a 50K-token review prompt completes in ≈ 30 s and an audit prompt in ≈ 85 s on the configured endpoint.

### VRF and sortition

The deployed `MockVRFCoordinator` accepts any non-zero proof tuple and returns
`randomness = keccak256(publicKey, proof, core, requestId, phase, epoch, reviewer, target, phaseStartBlock, finalityFactor)`.
All ten candidate reviewers register with the same VRF public key from `contracts/lib/vrf-solidity/test/data.json`, so per-reviewer sortition divergence is driven entirely by the participant address term. Production deployments should swap in `FRAINVRFVerifier` and per-reviewer keypairs.

The orchestrator's prescreen routine reproduces the same `randomness % 10000 < electionDifficulty` check off-chain (in [src/reviewer-agent/chain/sortition.ts](src/reviewer-agent/chain/sortition.ts)) so it can pick three candidates that, at the predicted `phaseStartBlock`, all pass review sortition and form valid mutual audit pairs.

### Content service as the canonical store

The content-service holds two kinds of artifact: `proposals` (the document under review, addressed by id) and `reports` (review artifacts, addressed by hash). Its `POST /reports` endpoint canonicalizes the artifact (sorted keys + UTF-8) and recomputes `keccak256` server-side, so a report URI is structurally `content://reports/0x<hash>` where the hash matches what the on-chain `ReviewRevealed` event will carry. Audit-time hash verification against `reportHash` is therefore exact.

For requester UX, the content-service also exposes a relayed USDAIO flow:

- `POST /request-intents/usdaio` returns the exact EIP-712 `RequestIntent` payload for `PaymentRouter.createRequestWithUSDAIOBySig(...)`.
- `POST /requests/relayed-document` accepts the requester signature and document, sends the relayed transaction with `CONTENT_RELAYER_PRIVATE_KEY`, verifies the emitted `RequestPaid` event and lifecycle requester, then stores the document.

The requester still pays the protocol fee from their own USDAIO balance through `PaymentRouter` allowance; the relayer only pays gas.

### Event ordering

The agent's chain-event poller in [src/reviewer-agent/chain/events.ts](src/reviewer-agent/chain/events.ts) merges `StatusChanged`, `ReviewRevealed`, and `RequestFinalized` log batches into a single chronological stream sorted by `(blockNumber, logIndex)` before emitting. This is important because a `ReviewRevealed` and the subsequent `StatusChanged(AuditCommit)` can land in the same transaction (the contract calls `_advance` immediately after `emit ReviewRevealed`); without chronological merging, an `AuditCommit` listener can fire before the matching `ReviewRevealed` is recorded into the agent's local state, causing the auditor to skip itself.

### Nonce management

`ethers v6` `Wallet.sendTransaction(...)` fetches the current pending nonce on each call. Under rapid sequential transactions on hardhat, a stale nonce can be reused. All wallets in the orchestrator and registration helper that issue more than one transaction in a row are wrapped in `NonceManager`, which tracks sent nonces locally.

### Off-chain layering

The agent code is split along the boundaries described in `REVIEWER_AGENT_INTERFACES § 1`:

- `llm/` — produces and validates structured semantic outputs only. Never sees private keys, transaction calldata, seeds, or VRF secret material.
- `chain/` — owns provider, signer, contract handles, VRF inputs, sortition pre-checks, and event indexing.
- `runtime/` — owns canonical artifact construction, seed generation, encrypted state persistence, and the dispatch from chain events into review/audit flows.

State (`src/reviewer-agent/runtime/state.ts`) writes per-request JSON files to a per-agent directory. Seeds are encrypted at rest with ChaCha20-Poly1305 keyed on `AGENT_STATE_KEY`. The orchestrator generates one such key per E2E run and passes it into each agent.

## Known Limitations

- The mock VRF coordinator means `vrfProof` is reused across agents. Real BN254 signing is out of scope for this run; swap to `DAIOVRFCoordinator` + `FRAINVRFVerifier` plus per-agent keypairs for production-like testing.
- `phaseStartBlock` prediction in the prescreen is best-effort; if the actual block diverges, agents fall back to runtime sortition checks. The E2E prescreen chooses five agents for quorum 3 to leave margin under review/audit sortition.
- The `markitdown` PDF → markdown conversion can drop spaces between words in dense academic PDFs (BRAIN paper exhibits this). The LLM tolerates it but a higher-fidelity converter would improve report quality.
- `gpt-oss-120b` JSON output occasionally produces extra whitespace; the client trims and accepts ```json fences as a safety net even though `response_format=json_object` is requested.

## References

- [REVIEWER_AGENT_INTERFACES.md](REVIEWER_AGENT_INTERFACES.md) — off-chain contract spec
- [contracts/PROPOSAL.md](contracts/PROPOSAL.md) — protocol design
- [contracts/BRAIN.pdf](contracts/BRAIN.pdf) — BRAIN paper (used as the sample document)
- [contracts/BlockFlow.pdf](contracts/BlockFlow.pdf) — BlockFlow paper (basis for consensus scoring)
