# DAIO Reviewer Agent Interfaces

This document defines the reviewer-agent interface for the current DAIO contract implementation.

The reviewer agent has two primary work functions:

| Function | Meaning | On-chain phase |
| --- | --- | --- |
| Review | Evaluate the original request artifact, produce a proposal score, and publish a review report. | `ReviewCommit`, `ReviewReveal` |
| Audit | Evaluate other revealed review reports, score their report quality, and reveal target audit scores. | `AuditCommit`, `AuditReveal` |

Registration, staking, identity, VRF proving, storage, event indexing, transaction signing, and timeout handling are supporting runtime responsibilities. They are not LLM responsibilities.

## 1. Hard Boundaries

The agent implementation must separate three layers:

| Layer | Responsibility |
| --- | --- |
| LLM | Reads request/report content and returns structured semantic outputs only. |
| Agent runtime | Fetches content, verifies hashes, canonicalizes outputs, stores reports, computes hashes, creates VRF proofs, manages seeds, submits transactions, and monitors events. |
| Contracts | Validate identity, eligibility, review VRF selection, commit/reveal consistency, full-audit targets, scoring, settlement, slashing, and reputation. |

The LLM must never receive or emit private keys, transaction calldata signatures, wallet mnemonics, raw commit seeds, or VRF secret material. The runtime owns those.

All DAIO scores use `SCALE = 10000`.

| Value | Meaning |
| --- | --- |
| `0` | Lowest possible score. |
| `10000` | Highest possible score. |
| score type | Integer, `uint16`, inclusive range `0..10000`. |

## 2. Request Status Values

The current `DAIOCore.RequestStatus` enum is:

| Name | Value |
| --- | ---: |
| `None` | `0` |
| `Queued` | `1` |
| `ReviewCommit` | `2` |
| `ReviewReveal` | `3` |
| `AuditCommit` | `4` |
| `AuditReveal` | `5` |
| `Finalized` | `6` |
| `Cancelled` | `7` |
| `Failed` | `8` |
| `Unresolved` | `9` |

## 3. LLM Interface

The LLM interface is intentionally contract-agnostic. It produces deterministic JSON that the runtime can convert into report artifacts and contract inputs.

### 3.1 Common LLM Input Envelope

Every LLM call must receive this envelope:

```json
{
  "schema": "daio.llm.input.v1",
  "task": "review",
  "chain": {
    "chainId": 11155111,
    "core": "0xCore",
    "commitRevealManager": "0xCommitRevealManager"
  },
  "request": {
    "requestId": "1",
    "proposalURI": "ipfs://...",
    "proposalHash": "0x...",
    "rubricHash": "0x...",
    "domainMask": "1",
    "tier": "Fast",
    "status": "ReviewCommit"
  },
  "reviewer": {
    "wallet": "0xReviewer",
    "ensName": "reviewer.daio.eth",
    "agentId": "1001",
    "domainMask": "1"
  },
  "content": {
    "proposal": {
      "uri": "ipfs://...",
      "mimeType": "text/markdown",
      "text": "..."
    },
    "rubric": {
      "hash": "0x...",
      "text": "..."
    }
  },
  "constraints": {
    "scoreScale": 10000,
    "outputLanguage": "en",
    "maxReportBytes": 200000
  }
}
```

`task` must be one of:

| Task | Description |
| --- | --- |
| `review` | Produce a proposal score and review report. |
| `audit` | Produce quality scores for assigned target reports. |

The runtime should reject LLM output that is not valid JSON, contains scores outside `0..10000`, omits required fields, or changes request/reviewer identifiers.

### 3.2 Review LLM Input

For `task = "review"`, `content.proposal` and `content.rubric` are required. The runtime must verify request content before calling the LLM where possible:

| Check | Required behavior |
| --- | --- |
| `proposalURI` fetch | Fetch immutable content from IPFS, Arweave, an approved content gateway, or a hash-addressed content service (`content://...`). |
| `proposalHash` | Verify against the configured canonical bytes. If the requester hash scheme is unknown, record that verification was not possible. |
| `rubricHash` | Verify rubric content if the rubric is available off-chain. An inline rubric literal supplied directly to the LLM (without a separate content store) is also acceptable provided the runtime records a deterministic `keccak256` placeholder. |

### 3.3 Review LLM Output

The LLM must return only JSON:

```json
{
  "schema": "daio.review.output.v1",
  "requestId": "1",
  "reviewer": "0xReviewer",
  "proposalScore": 8000,
  "report": {
    "summary": "Short neutral summary of the artifact.",
    "rubricAssessments": [
      {
        "criterion": "technical_correctness",
        "score": 8200,
        "rationale": "..."
      }
    ],
    "strengths": ["..."],
    "weaknesses": ["..."],
    "risks": ["..."],
    "recommendation": "accept",
    "confidence": 7600
  },
  "metadata": {
    "model": "model-name",
    "createdAt": "2026-05-01T00:00:00Z"
  }
}
```

Required fields:

| Field | Type | Rule |
| --- | --- | --- |
| `schema` | string | Must equal `daio.review.output.v1`. |
| `requestId` | string integer | Must match runtime request ID. |
| `reviewer` | address | Must match signing reviewer wallet. |
| `proposalScore` | integer | `0..10000`. Used on-chain. |
| `report` | object | Stored off-chain and represented on-chain by `reportURI` and `reportHash`. |

The runtime converts this output into a canonical review artifact. Recommended artifact:

```json
{
  "schema": "daio.review.artifact.v1",
  "requestId": "1",
  "reviewer": "0xReviewer",
  "proposalScore": 8000,
  "report": {},
  "source": {
    "proposalURI": "ipfs://...",
    "proposalHash": "0x...",
    "rubricHash": "0x..."
  },
  "metadata": {}
}
```

The runtime then stores the artifact and derives:

| Runtime field | Derivation |
| --- | --- |
| `reportURI` | Immutable storage URI for the canonical review artifact. |
| `reportHash` | `keccak256(canonicalReviewArtifactBytes)`. |
| `resultHash` | `commitReveal.hashReviewReveal(requestId, reviewer, proposalScore, reportHash, reportURI)`. |
| `seed` | Cryptographically random `uint256`, kept private until reveal. |

Only `proposalScore`, `reportHash`, `reportURI`, and `seed` are revealed on-chain.

### 3.4 Audit LLM Input

For `task = "audit"`, the runtime must provide the original proposal/rubric plus canonical target reports selected by the contract rules.

```json
{
  "schema": "daio.llm.input.v1",
  "task": "audit",
  "chain": {
    "chainId": 11155111,
    "core": "0xCore",
    "commitRevealManager": "0xCommitRevealManager"
  },
  "request": {
    "requestId": "1",
    "proposalURI": "ipfs://...",
    "proposalHash": "0x...",
    "rubricHash": "0x...",
    "domainMask": "1",
    "tier": "Fast",
    "status": "AuditCommit"
  },
  "auditor": {
    "wallet": "0xAuditor",
    "ensName": "auditor.daio.eth",
    "agentId": "1002"
  },
  "content": {
    "proposal": {
      "uri": "ipfs://...",
      "mimeType": "text/markdown",
      "text": "..."
    },
    "rubric": {
      "hash": "0x...",
      "text": "..."
    },
    "targets": [
      {
        "targetReviewer": "0xTargetReviewer",
        "proposalScore": 6000,
        "reportURI": "ipfs://...",
        "reportHash": "0x...",
        "report": {}
      }
    ]
  },
  "constraints": {
    "scoreScale": 10000,
    "targetOrder": "must_preserve_input_order"
  }
}
```

The runtime must verify every target report:

| Check | Required behavior |
| --- | --- |
| Target is canonical | Target must be every revealed reviewer except the auditor, in `ReviewRevealed` log order. |
| No self-audit | `targetReviewer != auditor`. |
| Revealed review exists | Target must have emitted `ReviewRevealed` for the request. |
| `reportHash` | Fetched report artifact must hash to the on-chain `reportHash`. |

### 3.5 Audit LLM Output

The LLM must return only JSON:

```json
{
  "schema": "daio.audit.output.v1",
  "requestId": "1",
  "auditor": "0xAuditor",
  "targetEvaluations": [
    {
      "targetReviewer": "0xTargetReviewer",
      "score": 7000,
      "rationale": "The report identifies the main risks but misses one material issue.",
      "confidence": 7400
    }
  ],
  "metadata": {
    "model": "model-name",
    "createdAt": "2026-05-01T00:00:00Z"
  }
}
```

Required fields:

| Field | Type | Rule |
| --- | --- | --- |
| `schema` | string | Must equal `daio.audit.output.v1`. |
| `requestId` | string integer | Must match runtime request ID. |
| `auditor` | address | Must match signing auditor wallet. |
| `targetEvaluations` | array | Must match canonical targets exactly. |
| `targetEvaluations[].targetReviewer` | address | Must preserve runtime canonical target order. |
| `targetEvaluations[].score` | integer | `0..10000`. Used on-chain. |

Current contracts only reveal audit target addresses and scores on-chain. Audit rationales are off-chain runtime artifacts unless a future contract adds audit report URIs.

The runtime derives:

| Runtime field | Derivation |
| --- | --- |
| `targets` | Ordered `targetEvaluations[].targetReviewer`. |
| `scores` | Ordered `targetEvaluations[].score`. |
| `auditArtifactURI` | Optional immutable URI for audit rationale and metadata. Not currently used by `DAIOCore`. |
| `resultHash` | `commitReveal.hashAuditReveal(requestId, auditor, targets, scores)`. |
| `seed` | Cryptographically random `uint256`, kept private until reveal. |

## 4. Blockchain Interface

The official reviewer-facing write entrypoint is `DAIOCommitRevealManager`. The agent must not call manager-only `DAIOCore` submit/reveal methods directly.

### 4.1 Required Contracts

| Contract | Agent use |
| --- | --- |
| `DAIOCore` | Read request lifecycle/results and emits phase events. |
| `DAIOCommitRevealManager` | Submit review/audit commits and reveals. |
| `ReviewerRegistry` | Read registration, eligibility, public VRF key, and agent ID. |
| `DAIOVRFCoordinator` | Build and verify review VRF messages/randomness. In test/MVP deployments, `MockVRFCoordinator` exposes the same `randomness(...)` view and is a drop-in substitute. |
| `AssignmentManager` | Compatibility helper for full-audit target previews; audit commits no longer submit target proofs. |
| `ReputationReader` (optional) | Read long-term and request-level reputation signals. Request-level signals are also available directly from `DAIOCore.getReviewerResult(requestId, reviewer)` (see § 4.4), so a runtime that only needs request-level data may skip this contract. |
| `StakeVault` / `USDAIO` | Registration stake approval and balance checks. |

### 4.2 Registration and Eligibility

Before doing work, a reviewer wallet must be registered and eligible.

```solidity
USDAIO.approve(stakeVault, stakeAmount)

ReviewerRegistry.registerReviewer(
    string ensName,
    bytes32 ensNode,
    uint256 agentId,
    uint256 domainMask,
    uint256[2] vrfPublicKey,
    uint256 stakeAmount
)
```

Runtime preflight reads:

```solidity
ReviewerRegistry.getReviewer(address reviewer)
ReviewerRegistry.isEligible(address reviewer, uint256 domainMask)
ReviewerRegistry.vrfPublicKey(address reviewer)
ReviewerRegistry.agentId(address reviewer)
```

Eligibility requires registration, active state, no suspension, enough available stake, no cooldown, matching domain mask, and passing the reputation gate.

`getReviewer` also returns `ensNode` and `ensName`; runtimes should pass that registered metadata to the LLM instead of inventing display names locally.

A test/MVP runtime that registered every reviewer with a single shared VRF public key (e.g. when targeting `MockVRFCoordinator`) may load that key from its deployment configuration instead of issuing a per-call `vrfPublicKey(...)` read. Production deployments with per-reviewer keypairs must read `vrfPublicKey(reviewer)` from the registry on every VRF operation.

### 4.3 Request and Event Indexing

The current contracts do not expose every phase-internal field through getters. The runtime must index events and transaction block numbers.

Indexed state required for the core review/audit flow:

| State | Source |
| --- | --- |
| Phase changes | `StatusChanged(requestId, status)` and the block number of that event transaction |
| Review committee order | `ReviewRevealed(requestId, reviewer, proposalScore, reportHash, reportURI)` in log order |
| Final result | `RequestFinalized` and `getRequestFinalResult` |

Indexed state recommended for observability and debugging (not required for correctness):

| State | Source |
| --- | --- |
| Request creation | `RequestCreated(requestId, requester, tier, feePaid, priorityFee)` |
| Audit commits/reveals | `AuditCommitted`, `AuditRevealed` |
| Faults | `ProtocolFault` |

The phase start block needed for VRF messages is the block number of the transaction that emitted the latest relevant `StatusChanged` event:

| Phase | Required phase start block |
| --- | --- |
| Review sortition | Block where status became `ReviewCommit`. |
| Audit target selection | Block where status became `AuditCommit`; no VRF message is needed in the current full-audit flow. |

The runtime must also know the deployed tier configuration, especially:

| Config | Use |
| --- | --- |
| `reviewElectionDifficulty` | Local precheck for review sortition. |
| `auditElectionDifficulty` | Must be `10000` in current full-audit configs. |
| `auditTargetLimit` | Must equal `reviewRevealQuorum - 1`; agents audit every revealed peer. |
| `reviewEpochSize` / `auditEpochSize` | Interpreting lifecycle epochs. |
| `finalityFactor` | VRF message construction. |
| timeouts | Avoid committing if reveal cannot be completed in time. |

If the deployment does not publish this config off-chain, the runtime can still submit and let contracts validate, but it cannot safely precompute pass/fail decisions. A production deployment should publish these configs or add explicit view getters.

### 4.4 Core Read Methods

```solidity
DAIOCore.getRequestLifecycle(uint256 requestId)
returns (
    address requester,
    RequestStatus status,
    uint256 feePaid,
    uint256 priorityFee,
    uint256 retryCount,
    uint256 committeeEpoch,
    uint256 auditEpoch,
    uint256 activePriority,
    bool lowConfidence
)

DAIOCore.getRequestFinalResult(uint256 requestId)
returns (
    RequestStatus status,
    uint256 finalProposalScore,
    uint256 confidence,
    uint256 auditCoverage,
    uint256 scoreDispersion,
    uint256 finalReliability,
    bool lowConfidence,
    uint256 faultSignal
)

DAIOCore.getReviewerResult(uint256 requestId, address reviewer)
returns (
    uint256 reportQualityMedian,
    uint256 normalizedReportQuality,
    uint256 auditReliabilityRaw,
    uint256 normalizedAuditReliability,
    uint256 finalContribution,
    uint256 scoreAgreement,
    uint256 reward,
    bool minorityOpinion,
    bool covered,
    bool protocolFault
)
```

### 4.5 VRF Message Interface

For review sortition:

```solidity
DAIOVRFCoordinator.messageFor(
    core,
    requestId,
    keccak256("DAIO_REVIEW_SORTITION"),
    committeeEpoch,
    reviewer,
    address(0),
    reviewPhaseStartBlock,
    finalityFactor
)
```

The runtime signs/proves the returned message using the reviewer's VRF secret key and submits the proof as `uint256[4]`.

Sortition score:

```text
score = uint256(keccak256(abi.encode(phase, requestId, participant, target, randomness))) % 10000
pass = score < electionDifficulty
```

`target` is `address(0)` for review sortition. The current full-audit flow does not use target-specific audit VRF proofs.

When the deployment uses `MockVRFCoordinator` (test/MVP path), the runtime may bypass `messageFor` and the VRF signing step entirely: any non-zero `uint256[4]` is accepted as a proof, and `randomness(...)` is computed deterministically by hashing the same inputs that `messageFor` would have encoded. A common pattern is to load a single `(publicKey, proof)` pair from a known VRF test vector (e.g. `lib/vrf-solidity/test/data.json` decoded via `FRAINVRFVerifier.decodePoint` / `decodeProof`) and reuse it across all phases. Sortition divergence between participants then comes from the participant address term inside the local `score = keccak256(...) % 10000` check, which is identical to the production formula. Production deployments with `DAIOVRFCoordinator` + `FRAINVRFVerifier` and per-reviewer keypairs must perform the full `messageFor` + sign + submit flow.

### 4.6 Review Commit/Reveal Interface

Commit preconditions:

| Condition | Required |
| --- | --- |
| Request status | `ReviewCommit`. |
| Reviewer eligibility | `ReviewerRegistry.isEligible(reviewer, request.domainMask) == true`. |
| VRF | Valid review proof and passing sortition. |
| LLM output | Valid `daio.review.output.v1`. |
| Report storage | Immutable `reportURI` and verified `reportHash`. |

Commit:

```solidity
bytes32 resultHash = DAIOCommitRevealManager.hashReviewReveal(
    requestId,
    reviewer,
    proposalScore,
    reportHash,
    reportURI
)

DAIOCommitRevealManager.commitReview(
    requestId,
    resultHash,
    seed,
    vrfProof
)
```

The underlying saved commit is:

```text
keccak256(abi.encodePacked(resultHash, reviewer, seed))
```

Reveal:

```solidity
DAIOCommitRevealManager.revealReview(
    requestId,
    proposalScore,
    reportHash,
    reportURI,
    seed
)
```

The runtime must retain `seed`, `proposalScore`, `reportHash`, and `reportURI` durably after commit. Losing them can cause missed reveal slashing.

### 4.7 Audit Commit/Reveal Interface

Audit preconditions:

| Condition | Required |
| --- | --- |
| Request status | `AuditCommit`. |
| Auditor | Must have revealed its own review for the same request. |
| Target proofs | Must be an empty array. Non-empty target proofs are rejected. |
| Canonical targets | Must be every revealed reviewer except self, in revealed-reviewer order. |
| LLM output | Valid `daio.audit.output.v1`. |

Target order is critical. It must follow the `ReviewRevealed` event order for all revealed reviewers, skipping the auditor itself.

Commit:

```solidity
bytes32 resultHash = DAIOCommitRevealManager.hashAuditReveal(
    requestId,
    auditor,
    targets,
    scores
)

DAIOCommitRevealManager.commitAudit(
    requestId,
    resultHash,
    seed,
    new uint256[4][](0)
)
```

Reveal:

```solidity
DAIOCommitRevealManager.revealAudit(
    requestId,
    targets,
    scores,
    seed
)
```

The `targets` and `scores` arrays revealed on-chain must exactly match the committed `resultHash`. Targets must be canonical, non-duplicate, not self, and score values must be `0..10000`.

### 4.8 Reputation Reads

After finalization, the runtime can read long-term reputation through `ReputationReader`:

```solidity
ReputationReader.longTermSignals(address reviewer)
returns (
    uint256 samples,
    uint256 reportQuality,
    uint256 auditReliability,
    uint256 finalContribution,
    uint256 protocolCompliance
)

ReputationReader.requestSignals(uint256 requestId, address reviewer)
returns (
    uint256 reportQuality,
    uint256 auditReliability,
    uint256 finalContribution,
    uint256 scoreAgreement,
    uint256 reward,
    bool minorityOpinion,
    bool covered,
    bool protocolFault
)
```

Request-level signals are also a strict subset of `DAIOCore.getReviewerResult(requestId, reviewer)` (see § 4.4). A runtime that only consumes request-level data may use `getReviewerResult` directly and skip `ReputationReader` entirely; only long-term signals require the dedicated reader.

ERC-8004 feedback is written by `ReputationLedger` through `ERC8004Adapter`; the reviewer agent should treat the official adapter as the canonical external reputation writer.

## 5. End-to-End Runtime Flow

### 5.1 Review Flow

1. Watch `StatusChanged(requestId, ReviewCommit)`.
2. Read `getRequestLifecycle(requestId)`.
3. Check reviewer registration and `isEligible`.
4. Reconstruct `reviewPhaseStartBlock` from the phase-change event block.
5. Build review VRF message and produce `vrfProof`.
6. Locally compute sortition pass if config is available.
7. Fetch proposal/rubric content and verify hashes where possible.
8. Call LLM with `task = "review"`.
9. Validate LLM JSON and score bounds.
10. Store canonical review artifact and derive `reportURI` and `reportHash`.
11. Generate private `seed`.
12. Compute `resultHash`.
13. Submit `commitReview`.
14. Watch `StatusChanged(requestId, ReviewReveal)`.
15. Submit `revealReview` before timeout.
16. Persist receipt, report URI, hash, score, seed, and transaction hashes.

### 5.2 Audit Flow

1. Watch `StatusChanged(requestId, AuditCommit)`.
2. Confirm this auditor emitted `ReviewRevealed` for the same request.
3. Reconstruct `auditPhaseStartBlock` from the phase-change event block.
4. Reconstruct `revealedReviewers` from `ReviewRevealed` events in log order.
5. Select every revealed reviewer except self, preserving `ReviewRevealed` log order.
6. If no canonical targets are selected, do not call the LLM or commit audit.
7. Fetch every canonical target report and verify `reportHash`.
8. Call LLM with `task = "audit"` and canonical targets in exact order.
9. Validate LLM JSON, target order, and score bounds.
10. Optionally store an off-chain audit artifact.
11. Generate private `seed`.
12. Compute `resultHash`.
13. Submit `commitAudit` with an empty target-proof array.
14. Watch `StatusChanged(requestId, AuditReveal)`.
15. Submit `revealAudit` before timeout.
16. Persist target list, scores, seed, and transaction hashes.

## 6. Fault Avoidance Rules

The runtime must avoid these cases because the current contracts can slash or mark protocol faults:

| Fault | Avoidance rule |
| --- | --- |
| Invalid review VRF proof | Build proofs from exact `messageFor` inputs. |
| Review sortition failure | Precheck pass when config is available; otherwise accept risk before submitting. |
| Missing reveal after commit | Never commit unless output and seed are durably stored and reveal automation is active. |
| Commit/reveal mismatch | Derive reveal payload from the exact values used for `resultHash`. |
| Non-canonical audit target | Audit every revealed peer and preserve target order. |
| Self-audit | Reject any target equal to auditor wallet. |
| Duplicate audit target | Reject duplicate targets before commit. |
| Score out of bounds | Validate every score is integer `0..10000`. |
| Mutable report URI | Store artifacts in immutable storage; verify hash before reveal. |

## 7. Minimal Runtime State

The agent runtime must persist at least the fields required to reveal without recomputing the LLM output:

```json
{
  "requestId": "1",
  "phase": "ReviewCommit",
  "reviewer": "0xReviewer",
  "review": {
    "proposalScore": 8000,
    "reportURI": "ipfs://...",
    "reportHash": "0x...",
    "resultHash": "0x...",
    "seed": "0x...",
    "commitTx": "0x...",
    "revealTx": "0x..."
  },
  "audit": {
    "targets": ["0xTargetReviewer"],
    "scores": [7000],
    "resultHash": "0x...",
    "seed": "0x...",
    "commitTx": "0x...",
    "revealTx": "0x..."
  }
}
```

The `review` and `audit` blocks are required once the corresponding commit has been submitted. Seeds must be encrypted at rest until reveal.

The following `vrf` block is recommended but not required, since each value can be re-derived from the chain on reveal:

```json
{
  "vrf": {
    "reviewPhaseStartBlock": "123",
    "auditPhaseStartBlock": "127",
    "committeeEpoch": "4",
    "auditEpoch": "4"
  }
}
```

Persisting it explicitly makes crash recovery cheaper and decouples reveal from the state of the agent's event poller.

If the process restarts after commit, it must be able to reveal without recomputing LLM outputs. A production-grade runtime should additionally replay historical `StatusChanged` and `ReviewRevealed` events from the request's creation block on startup so it can pick up reveal phases that fired while the agent was down. The reference implementation in this repository starts polling from the chain head on boot, so it relies on the agent process staying alive across the commit/reveal window; full crash-recovery replay is left as future work.

## 8. Current Implementation Notes

The current E2E path verifies:

1. Direct USDAIO request creation through `PaymentRouter`.
2. Request queue start through `DAIOCore.startNextRequest`.
3. Review commit/reveal through `DAIOCommitRevealManager`.
4. Full-audit target validation by `DAIOCore`.
5. Audit commit/reveal through `DAIOCommitRevealManager`.
6. Finalization through `ConsensusScoring`, `Settlement`, `ReputationLedger`, and `StakeVault`.

Current contract limitations relevant to agent builders:

| Limitation | Runtime handling |
| --- | --- |
| `phaseStartedBlock` is not exposed by a getter. | Index `StatusChanged` event block numbers. |
| Revealed reviewer list is internal. | Reconstruct from `ReviewRevealed` events in log order. |
| Tier config is not exposed by a getter. | Load deployment config off-chain or add a view getter in a future contract change. The reference implementation reads tier-config values (`reviewElectionDifficulty`, `auditElectionDifficulty`, `auditTargetLimit`, `finalityFactor`) from storage with fallback flags. |
| Audit rationale is not stored on-chain. | Store optional audit artifacts off-chain; only target scores affect current contracts. |
| Test/MVP VRF | The reference implementation deploys `MockVRFCoordinator` and registers all reviewers with a single VRF public key derived from a known test vector. This is sufficient to exercise sortition, commit/reveal, audit, and finalization but does not produce real BN254 randomness. Production should swap in `DAIOVRFCoordinator` + `FRAINVRFVerifier` plus per-reviewer keypairs. |
| Crash recovery | The reference implementation polls events from the chain head on startup and does not replay historical `StatusChanged` / `ReviewRevealed` events. An agent that crashes between commit and reveal cannot resume on its own. Production should replay events from the request's creation block on boot. |
