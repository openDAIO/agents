# Frontend API and Contract View Reference

This document lists the HTTP endpoints and on-chain view calls a frontend can use for DAIO request creation, document upload, status display, reasoning lookup, and scoring/accounting views.

Default local service URLs:

- Content API: `http://127.0.0.1:18002`
- MarkItDown API: `http://127.0.0.1:18003`

Production deployments should put both APIs behind TLS, authentication, rate limits, and upload size controls.

## Constants

Request status values from `DAIOCore.RequestStatus`:

| Value | Name |
| ---: | --- |
| `0` | `None` |
| `1` | `Queued` |
| `2` | `ReviewCommit` |
| `3` | `ReviewReveal` |
| `4` | `AuditCommit` |
| `5` | `AuditReveal` |
| `6` | `Finalized` |
| `7` | `Cancelled` |
| `8` | `Failed` |
| `9` | `Unresolved` |

Service tiers:

| Value | Name |
| ---: | --- |
| `0` | `Fast` |
| `1` | `Standard` |
| `2` | `Critical` |

Round ledger round IDs:

| Value | Name | Meaning |
| ---: | --- | --- |
| `0` | `review` | Raw review score round |
| `1` | `audit_consensus` | Audit-weighted consensus round |
| `2` | `reputation_final` | ERC-8004/reputation-weighted final round |

Scores, weights, confidence, and coverage use `0..10000` scale unless noted otherwise. USDAIO amounts are `uint256` with 18 decimals.

## Recommended Request Flow

1. Convert an uploaded file to Markdown through the MarkItDown API if needed.
2. Read `DAIOCore.baseRequestFee()` and choose a `priorityFee`.
3. Ask the requester wallet to approve USDAIO spending for `PaymentRouter`:

```ts
await usdaio.approve(paymentRouterAddress, baseRequestFee + priorityFee);
```

4. Call `POST /request-intents/usdaio` to get the EIP-712 typed data.
5. Ask the requester wallet to sign the returned typed data.
6. Call `POST /requests/relayed-document` with the signature and document text.
7. Track the returned `requestId` through the Content API and contract views.

The relayer pays gas for `PaymentRouter.createRequestWithUSDAIOBySig(...)`, but the request fee is still pulled from the requester through `PaymentRouter` allowance. The on-chain requester remains the requester address, not the relayer.

## MarkItDown API

### `GET /health`

Health check.

Response:

```json
{ "ok": true }
```

### `POST /convert`

Converts an uploaded document to Markdown.

Multipart form:

- Field: `file`

Raw body alternative:

- Header: `X-Filename: paper.pdf`
- Body: file bytes

Response:

```json
{
  "filename": "paper.pdf",
  "markdown": "# Converted markdown...",
  "bytes": 12345,
  "webpConverted": false
}
```

Errors:

- `400 empty_body`
- `400 multipart_field_file_required`
- `413 upload_too_large`
- `422 conversion_failed`

## Content API

### `GET /health`

Health check.

Response:

```json
{ "ok": true }
```

### `POST /request-intents/usdaio`

Builds the EIP-712 typed data that the requester must sign for relayed USDAIO request creation.

Request body:

```json
{
  "requester": "0xRequester",
  "id": "paper-001",
  "proposalURI": "content://proposals/paper-001",
  "text": "# Document markdown",
  "rubricHash": "0x...",
  "domainMask": "1",
  "tier": 0,
  "priorityFee": "0",
  "deadline": "1770000000",
  "mimeType": "text/markdown"
}
```

Notes:

- Provide either `id` or `proposalURI`. If both are provided, `proposalURI` must be `content://proposals/<id>`.
- `rubricHash` is optional. If omitted, the API defaults to `keccak256("<id>:rubric")`.
- `domainMask` and `priorityFee` are decimal strings.
- `deadline` is optional here. If omitted, the API uses roughly one hour from the current server time.

Response:

```json
{
  "requester": "0xRequester",
  "id": "paper-001",
  "proposalURI": "content://proposals/paper-001",
  "proposalURIHash": "0x...",
  "proposalHash": "0x...",
  "rubricHash": "0x...",
  "domainMask": "1",
  "tier": 0,
  "tierName": "Fast",
  "priorityFee": "0",
  "nonce": "0",
  "deadline": "1770000000",
  "typedData": {
    "domain": {
      "name": "DAIOPaymentRouter",
      "version": "1",
      "chainId": 11155111,
      "verifyingContract": "0xPaymentRouter"
    },
    "primaryType": "RequestIntent",
    "types": {
      "RequestIntent": [
        { "name": "requester", "type": "address" },
        { "name": "proposalURIHash", "type": "bytes32" },
        { "name": "proposalHash", "type": "bytes32" },
        { "name": "rubricHash", "type": "bytes32" },
        { "name": "domainMask", "type": "uint256" },
        { "name": "tier", "type": "uint8" },
        { "name": "priorityFee", "type": "uint256" },
        { "name": "nonce", "type": "uint256" },
        { "name": "deadline", "type": "uint256" }
      ]
    },
    "message": {
      "requester": "0xRequester",
      "proposalURIHash": "0x...",
      "proposalHash": "0x...",
      "rubricHash": "0x...",
      "domainMask": "1",
      "tier": 0,
      "priorityFee": "0",
      "nonce": "0",
      "deadline": "1770000000"
    }
  }
}
```

Frontend signing example:

```ts
const signature = await signer.signTypedData(
  intent.typedData.domain,
  intent.typedData.types,
  intent.typedData.message,
);
```

### `POST /requests/relayed-document`

Submits the signed request intent through the content relayer, verifies the on-chain request transaction, and stores the document.

Request body:

```json
{
  "requester": "0xRequester",
  "signature": "0x...",
  "deadline": "1770000000",
  "id": "paper-001",
  "proposalURI": "content://proposals/paper-001",
  "text": "# Document markdown",
  "rubricHash": "0x...",
  "domainMask": "1",
  "tier": 0,
  "priorityFee": "0",
  "mimeType": "text/markdown"
}
```

Response:

```json
{
  "relayed": {
    "relayer": "0xRelayer",
    "requestId": "1",
    "txHash": "0x...",
    "blockNumber": 123456
  },
  "document": {
    "updatedAt": 1770000000000,
    "verified": {
      "requestId": "1",
      "requester": "0xRequester",
      "proposalURI": "content://proposals/paper-001",
      "proposalHash": "0x...",
      "rubricHash": "0x...",
      "domainMask": "1",
      "tier": 0,
      "tierName": "Fast",
      "priorityFee": "0",
      "txHash": "0x...",
      "paymentFunction": "createRequestWithUSDAIOBySig",
      "paymentToken": "0xUSDAIO",
      "amountPaid": "100000000000000000000",
      "blockNumber": 123456,
      "status": 1,
      "statusName": "Queued"
    },
    "proposal": {
      "uri": "content://proposals/paper-001",
      "id": "paper-001",
      "hash": "0x...",
      "mimeType": "text/markdown",
      "text": "# Document markdown"
    }
  }
}
```

Errors:

- `400 invalid_relayed_document`
- `400 id_or_proposal_uri_required`
- `400 unsupported_proposal_uri`
- `400 proposal_id_mismatch`
- `502 relayed_request_failed`
- `503 chain_verification_unavailable`

### `POST /requests/:requestId/document`

Stores a document after the requester has already created the on-chain request directly.

Request body:

```json
{
  "txHash": "0xPaymentTx",
  "requester": "0xRequester",
  "id": "paper-001",
  "text": "# Document markdown",
  "mimeType": "text/markdown"
}
```

The API verifies:

- The transaction succeeded.
- The transaction was sent to `PaymentRouter`.
- The payment call is supported.
- `proposalHash == keccak256(text)`.
- A matching `RequestPaid` event exists for `requestId`.
- The lifecycle requester matches the expected requester.

Supported payment calls:

- `createRequestWithUSDAIO(...)`
- `createRequestWithUSDAIOBySig(...)`
- `createRequestWithERC20(...)`
- `createRequestWithETH(...)`

Response shape is the same `document` object returned by `POST /requests/relayed-document`.

### `GET /requests/:requestId/document`

Returns the stored verified document and on-chain payment metadata.

### `GET /requests/:requestId/agent-statuses`

Returns all known off-chain agent status rows for a request.

Response:

```json
{
  "requestId": "1",
  "agents": [
    {
      "requestId": "1",
      "agent": "0xReviewer",
      "phase": "Finalized",
      "status": "finalized",
      "detail": null,
      "payload": {},
      "updatedAt": 1770000000000
    }
  ]
}
```

### `GET /requests/:requestId/agents/:agent/status`

Returns one agent status row. `:agent` must be an Ethereum address.

### `GET /requests/:requestId/agents/:agent/reasons`

Returns the model's final structured review/audit rationales and raw final artifacts for one agent.

Response:

```json
{
  "requestId": "1",
  "agent": "0xReviewer",
  "rawThinking": {
    "available": false,
    "reason": "Raw hidden model reasoning is not stored or exposed. This API returns the model's final structured rationales and raw final artifacts."
  },
  "review": {
    "reportHash": "0x...",
    "proposalScore": 6200,
    "summary": "...",
    "recommendation": "...",
    "confidence": 8200,
    "rubricAssessments": [],
    "strengths": [],
    "weaknesses": [],
    "risks": [],
    "rawFinalArtifact": {}
  },
  "audit": {
    "auditHash": "0x...",
    "targetEvaluations": [
      {
        "targetReviewer": "0xReviewer",
        "score": 7800,
        "rationale": "..."
      }
    ],
    "rawFinalArtifact": {}
  }
}
```

Important: hidden model chain-of-thought is intentionally not exposed. Use the structured rationales and final artifacts.

When `CONTENT_REQUIRE_AGENT_SIGNATURES=true`, status and reason data is written
only by requests signed with the reviewer/auditor wallet. The content API still
serves these as off-chain observability records. Frontends that need settlement
truth should cross-check contract views/events for finalized scores and rewards.
The current `content://...` URI scheme is resolved through the configured content
API, so deployments that use multiple content services need a mirroring/gateway
strategy or a globally resolvable URI scheme.

### Artifact Storage Endpoints

These are mostly agent/internal, but they can be useful for debugging or explorer pages.

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/proposals` | Store a proposal by `{ id, text, mimeType }`; returns `content://proposals/<id>` and hash. |
| `GET` | `/proposals/:id` | Read a stored proposal. |
| `POST` | `/reports` | Agent-only. Store canonical review artifact; with signature enforcement, body is `{ artifact, signature }`. |
| `GET` | `/reports/:hash` | Read a stored review artifact. |
| `POST` | `/audits` | Agent-only. Store canonical audit artifact; with signature enforcement, body is `{ artifact, signature }`. |
| `GET` | `/audits/:hash` | Read a stored audit artifact. |
| `PUT` | `/agent-status` | Agent-only status writer; with signature enforcement, body includes `signature`. Frontends should normally read status endpoints instead. |

## Contract Views

Use the deployment snapshot, usually `./.deployments/sepolia.json`, for contract addresses. The frontend should construct ethers/viem contracts with the ABI artifacts under `contracts/artifacts`.

### `USDAIOToken`

| View | Returns | Frontend use |
| --- | --- | --- |
| `name()` | `string` | Token metadata. |
| `symbol()` | `string` | Token metadata. |
| `decimals()` | `uint8` | Amount formatting. |
| `totalSupply()` | `uint256` | Token analytics. |
| `balanceOf(address account)` | `uint256` | Requester/reviewer balance. |
| `allowance(address account, address spender)` | `uint256` | Check requester approval to `PaymentRouter`. |
| `owner()` | `address` | Admin/debug display. |

Required wallet transaction for relayed requests:

```ts
await usdaio.approve(paymentRouterAddress, baseRequestFee + priorityFee);
```

### `PaymentRouter`

| View | Returns | Frontend use |
| --- | --- | --- |
| `usdaio()` | `address` | Resolve USDAIO token address. |
| `core()` | `address` | Resolve DAIOCore address. |
| `acceptedTokenRegistry()` | `address` | Resolve accepted-token registry. |
| `swapAdapter()` | `address` | Resolve swap adapter. |
| `domainSeparator()` | `bytes32` | Debug EIP-712 domain. |
| `nonces(address requester)` | `uint256` | Request intent nonce. The Content API reads this when building typed data. |
| `latestRequestByRequester(address requester)` | `uint256 requestId` | Find a user's latest request. |
| `latestRequestState(address requester)` | `(requestId, status, processing, completed)` | Compact dashboard state. |

Relevant non-view writes:

- `createRequestWithUSDAIO(...)`
- `createRequestWithUSDAIOBySig(...)`
- `createRequestWithERC20(...)`
- `createRequestWithETH(...)`

### `DAIOCore`

| View | Returns | Frontend use |
| --- | --- | --- |
| `baseRequestFee()` | `uint256` | Compute payment amount. |
| `maxActiveRequests()` | `uint256` | Show active request capacity. |
| `stakeVault()` | `address` | Resolve StakeVault address. |
| `getRequestLifecycle(uint256 requestId)` | `(requester, status, feePaid, priorityFee, retryCount, committeeEpoch, auditEpoch, activePriority, lowConfidence)` | Primary request status and current attempt. |

Useful non-view calls for operators/keepers:

- `startNextRequest()` moves a queued request into active processing if capacity exists.
- `syncRequest(requestId)` applies timeouts/finalization transitions when needed.
- `handleTimeout(requestId)` applies timeout handling.

### `DAIORoundLedger`

Use `attempt = retryCount` from `DAIOCore.getRequestLifecycle(requestId)`.

| View | Returns | Frontend use |
| --- | --- | --- |
| `getRoundAggregate(uint256 requestId, uint256 attempt, uint8 round)` | `(score, totalWeight, confidence, coverage, lowConfidence, closed, aborted)` | Round-level live/final aggregate. |
| `getReviewerRoundScore(uint256 requestId, uint256 attempt, uint8 round, address reviewer)` | `(score, weight, weightedScore, auditScore, reputationScore, available)` | Reviewer-level score/weight for each round. |
| `getReviewerRoundAccounting(uint256 requestId, uint256 attempt, uint8 round, address reviewer)` | `(reward, slashed, slashCount, lastSlashReasonHash, protocolFault, semanticFault)` | Per-reviewer reward/slash accounting. |
| `reviewerRoundWeight(uint256 requestId, uint256 attempt, uint8 round, address reviewer)` | `uint256` | Lightweight weight lookup. |
| `core()` | `address` | Debug/config display. |
| `owner()` | `address` | Admin/debug display. |

Recommended UI loop:

1. Read `DAIOCore.getRequestLifecycle(requestId)`.
2. Use returned `retryCount` as `attempt`.
3. Read `getRoundAggregate(requestId, attempt, 0..2)`.
4. For known reviewer addresses, read `getReviewerRoundScore(...)` and `getReviewerRoundAccounting(...)`.

### `ReviewerRegistry`

| View | Returns | Frontend use |
| --- | --- | --- |
| `getReviewer(address reviewer)` | `(registered, active, suspended, agentId, stake, domainMask, completedRequests, semanticStrikes, protocolFaults, cooldownUntilBlock)` | Reviewer profile. |
| `isEligible(address reviewer, uint256 domainMask)` | `bool` | Show whether reviewer can participate in a domain. |
| `availableStake(address reviewer)` | `uint256` | Stake capacity for new active requests. |
| `lockedStake(address reviewer)` | `uint256` | Total locked stake. |
| `requestLockedStake(uint256 requestId, address reviewer)` | `uint256` | Request-specific stake lock. |
| `vrfPublicKey(address reviewer)` | `uint256[2]` | Reviewer VRF key display/debug. |
| `agentId(address reviewer)` | `uint256` | ERC-8004 agent ID. |
| `minStake()` | `uint256` | Minimum stake requirement. |
| `minReputationSamples()` | `uint256` | Reputation gate setting. |
| `minFinalContribution()` | `uint256` | Reputation gate setting. |
| `minProtocolCompliance()` | `uint256` | Reputation gate setting. |
| `stakeVault()` | `address` | Resolve StakeVault. |
| `reputationLedger()` | `address` | Resolve ReputationLedger. |
| `ensVerifier()` | `address` | Identity module address. |
| `erc8004Adapter()` | `address` | ERC-8004 adapter address. |
| `core()` | `address` | Core address. |
| `owner()` | `address` | Admin/debug display. |

### `StakeVault`

| View | Returns | Frontend use |
| --- | --- | --- |
| `usdaio()` | `address` | Token address. |
| `stakes(address reviewer)` | `uint256` | Total reviewer stake held in vault. |
| `requestRewardPool(uint256 requestId)` | `uint256` | Remaining reward pool while request is open. |
| `requestProtocolFee(uint256 requestId)` | `uint256` | Remaining protocol fee while request is open. |
| `treasuryBalance()` | `uint256` | Accrued treasury balance. |
| `authorized(address account)` | `bool` | Admin/debug display. |
| `core()` | `address` | Core address. |
| `owner()` | `address` | Admin/debug display. |

### `ReputationLedger`

| View | Returns | Frontend use |
| --- | --- | --- |
| `reputations(address reviewer)` | `(samples, reportQuality, auditReliability, finalContribution, protocolCompliance)` | Long-term reviewer reputation. |
| `SCALE()` | `uint256` | Reputation scale, normally `10000`. |
| `erc8004Adapter()` | `address` | ERC-8004 adapter address. |
| `core()` | `address` | Core address. |
| `owner()` | `address` | Admin/debug display. |

### `DAIOCommitRevealManager`

| View/Pure | Returns | Frontend use |
| --- | --- | --- |
| `getReviewParticipants(uint256 requestId, uint256 attempt)` | `address[]` | Reviewer addresses that had accepted review commits. |
| `getAuditParticipants(uint256 requestId, uint256 attempt)` | `address[]` | Auditor addresses that had accepted audit commits. |
| `hashReviewReveal(uint256 requestId, address reviewer, uint16 proposalScore, bytes32 reportHash, string reportURI)` | `bytes32` | Debug commit/reveal hash. |
| `hashAuditReveal(uint256 requestId, address auditor, address[] targets, uint16[] scores)` | `bytes32` | Debug commit/reveal hash. |
| `saved_commits(uint256 round, address participant)` | `bytes32` | Debug commit state. |
| `revealed_hashed_value(uint256 round, address participant)` | `bytes32` | Debug reveal state. |
| `revealed_value(uint256 round, address participant)` | `bytes` | Debug reveal state. |
| `round()` | `uint256` | Inherited commit-reveal round state. |
| `core()` | `address` | Core address. |
| `owner()` | `address` | Admin/debug display. |

### `DAIOPriorityQueue`

| View | Returns | Frontend use |
| --- | --- | --- |
| `currentSize()` | `uint256` | Number of queued requests. |
| `top()` | `(uint256 priority, bytes32 encodedRequestId)` | Highest-priority queued request. Convert `encodedRequestId` to `uint256`. |
| `core()` | `address` | Core address. |
| `owner()` | `address` | Admin/debug display. |

### `AcceptedTokenRegistry`

| View | Returns | Frontend use |
| --- | --- | --- |
| `acceptedTokens(address token)` | `bool` | Whether a payment token is accepted. |
| `requiresSwap(address token)` | `bool` | Whether the token must be swapped to USDAIO. |
| `owner()` | `address` | Admin/debug display. |

### `AssignmentManager`

Mostly agent/debug-facing. Frontends usually do not need this for normal user pages.

| View | Returns | Frontend use |
| --- | --- | --- |
| `verifiedCanonicalAuditTargets(...)` | `(bool ok, address[] selectedTargets)` | Debug audit assignment reproduction. |
| `AUDIT_SORTITION()` | `bytes32` | Constant. |
| `SCALE()` | `uint256` | Constant, normally `10000`. |

## Suggested Frontend Screens

### Request Creation

Read:

- `DAIOCore.baseRequestFee()`
- `USDAIOToken.balanceOf(requester)`
- `USDAIOToken.allowance(requester, paymentRouter)`
- `PaymentRouter.nonces(requester)`

Use APIs:

- `POST /convert`
- `POST /request-intents/usdaio`
- `POST /requests/relayed-document`

### Request Detail

Read:

- `DAIOCore.getRequestLifecycle(requestId)`
- `GET /requests/:requestId/document`
- `PaymentRouter.latestRequestState(requester)` if starting from a requester address
- `DAIORoundLedger.getRoundAggregate(requestId, attempt, 0..2)`
- `DAIOCommitRevealManager.getReviewParticipants(requestId, attempt)`
- `DAIOCommitRevealManager.getAuditParticipants(requestId, attempt)`

### Reviewer Detail

Read:

- `ReviewerRegistry.getReviewer(reviewer)`
- `ReviewerRegistry.availableStake(reviewer)`
- `ReviewerRegistry.lockedStake(reviewer)`
- `ReputationLedger.reputations(reviewer)`
- `DAIORoundLedger.getReviewerRoundScore(requestId, attempt, round, reviewer)`
- `DAIORoundLedger.getReviewerRoundAccounting(requestId, attempt, round, reviewer)`

Use APIs:

- `GET /requests/:requestId/agents/:agent/status`
- `GET /requests/:requestId/agents/:agent/reasons`
