# Frontend API and Contract View Reference

This document lists the HTTP endpoints and on-chain view calls a frontend can use for DAIO request creation, document upload, status display, reasoning lookup, and scoring/accounting views.

Default local service URLs:

- Content API: `http://127.0.0.1:18002`
- MarkItDown API: `http://127.0.0.1:18003`

Production deployments should put both APIs behind TLS, authentication, rate limits, and upload size controls.

Browser frontends should normally call these services through the same HTTPS
origin or through an API gateway/reverse proxy. The bundled Docker Compose
runtime now enables CORS headers from `CORS_ALLOW_*` env values on both
content-service and MarkItDown, so local browser testing can call them directly.
For production, still prefer a gateway-level allowlist and keep write endpoints
authenticated.

Trust boundaries:

- Public/requester-facing: `POST /request-intents/usdaio`,
  `POST /requests/relayed-document`, and `POST /convert` if users upload files
  through your frontend.
- Public/read-facing, if the deployment intentionally supports third-party
  reviewers: `GET /requests/:requestId/document`,
  `GET /requests/:requestId/markdown`, `GET /proposals/:id/markdown`,
  `GET /reports/:hash`, and `GET /audits/:hash`.
- Agent/internal writes: `POST /reports`, `POST /audits`, and
  `PUT /agent-status`. Keep `CONTENT_REQUIRE_AGENT_SIGNATURES=true` so these
  writes must be signed by the corresponding reviewer/auditor wallet.
- Internal by default: reviewer-agent containers. They do not expose HTTP APIs.

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
8. Third-party agents can fetch the canonical converted Markdown with
   `GET /requests/:requestId/markdown`.

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

Endpoint summary:

| Method | Path | Frontend use |
| --- | --- | --- |
| `GET` | `/health` | Health check. |
| `POST` | `/request-intents/usdaio` | Build the EIP-712 `RequestIntent` for requester signing. |
| `POST` | `/requests/relayed-document` | Relay a signed USDAIO request and store the verified document. |
| `POST` | `/requests/document-from-tx` | Recover document storage from a successful payment transaction hash. |
| `POST` | `/requests/:requestId/document` | Store a document after the requester already created the on-chain request directly. |
| `GET` | `/requests/:requestId/document` | Read stored document metadata and verified payment/request metadata. |
| `GET` | `/requests/:requestId/chain-status` | Read current on-chain lifecycle directly from the configured chain RPC. |
| `GET` | `/requests/:requestId/markdown` | Read the canonical converted Markdown for a request. |
| `GET` | `/requests/:requestId/agent-statuses` | List all known off-chain agent statuses for a request. |
| `GET` | `/requests/:requestId/agents/:agent/status` | Read one agent's off-chain status. |
| `GET` | `/requests/:requestId/agents/:agent/reasons` | Read one agent's persisted final review/audit rationales. |
| `POST` | `/requests/:requestId/agents/:agent/ask` | Ask an agent-scoped question using request, chain, artifact, event, and Q&A context. |
| `GET` | `/requests/:requestId/agents/:agent/qa-history` | Read stored Q&A history for one request, agent, and session. |
| `POST` | `/requests/:requestId/agents/:agent/score-report` | Generate or read a cached finalized score report for one agent. |
| `POST` | `/requests/:requestId/final-report` | Generate or read a cached synthesized finalized request report. |
| `POST` | `/proposals` | Store proposal Markdown directly; mostly internal/debug. |
| `GET` | `/proposals/:id` | Read a stored proposal. |
| `GET` | `/proposals/:id/markdown` | Read stored proposal Markdown as JSON or raw Markdown. |
| `POST` | `/reports` | Agent-only signed review artifact writer. |
| `GET` | `/reports/:hash` | Read a canonical review artifact. |
| `POST` | `/audits` | Agent-only signed audit artifact writer. |
| `GET` | `/audits/:hash` | Read a canonical audit artifact. |
| `PUT` | `/agent-status` | Agent-only signed status writer. |

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

Submits the signed request intent through the content relayer, verifies the on-chain request transaction, and stores the document. The service preflights the signed call with `staticCall` before sending a real relayer transaction; if the requester nonce, allowance, deadline, or signature is stale, request a fresh intent and signature.

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

Response:

```json
{
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
```

### `GET /requests/:requestId/chain-status`

Returns the current on-chain lifecycle for a request. Use this as the source of
truth when local agent status rows are still replaying after restart.

Response:

```json
{
  "requestId": "1",
  "requester": "0xRequester",
  "status": 6,
  "statusName": "Finalized",
  "feePaid": "100000000000000000000",
  "priorityFee": "0",
  "retryCount": "0",
  "committeeEpoch": "123",
  "auditEpoch": "123",
  "activePriority": "0",
  "lowConfidence": false
}
```

### `GET /requests/:requestId/markdown`

Returns the stored Markdown document for a verified request. This is the
canonical off-chain document body third-party agents should review. The
`hash` field is the `keccak256` hash of this Markdown text and matches the
on-chain `proposalHash`.

JSON response:

```json
{
  "requestId": "1",
  "updatedAt": 1770000000000,
  "verified": {
    "requestId": "1",
    "proposalURI": "content://proposals/paper-001",
    "proposalHash": "0x..."
  },
  "proposal": {
    "uri": "content://proposals/paper-001",
    "id": "paper-001",
    "hash": "0x...",
    "mimeType": "text/markdown",
    "bytes": 12345,
    "markdown": "# Converted markdown"
  }
}
```

Raw Markdown response:

```http
GET /requests/1/markdown?format=raw
Accept: text/markdown
```

The raw response uses `Content-Type: text/markdown` and includes `ETag`,
`X-DAIO-Proposal-URI`, and `X-DAIO-Proposal-Hash` headers.

### `GET /proposals/:id/markdown`

Returns stored proposal Markdown directly by content id. Frontends normally
prefer `GET /requests/:requestId/markdown` for request pages because it also
includes the verified request metadata. This proposal endpoint is useful for
debugging, explorer pages, and third-party reviewers that already know the
`content://proposals/<id>` URI.

JSON response:

```json
{
  "uri": "content://proposals/paper-001",
  "id": "paper-001",
  "hash": "0x...",
  "mimeType": "text/markdown",
  "bytes": 12345,
  "markdown": "# Converted markdown"
}
```

Raw Markdown response:

```http
GET /proposals/paper-001/markdown?format=raw
Accept: text/markdown
```

The raw response uses `Content-Type: text/markdown` and includes `ETag`,
`X-DAIO-Proposal-URI`, and `X-DAIO-Proposal-Hash` headers.

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

### `POST /requests/:requestId/agents/:agent/ask`

Asks an arbitrary question from the perspective of a specific agent for a
specific request. This endpoint is public in the current deployment profile; no
auth header is required. It calls the same OpenAI-compatible LLM endpoint used by
reviewer agents.

The Q&A context is assembled from currently available data:

- request document and verified payment metadata, with proposal text capped by
  `LLM_PROPOSAL_CHAR_BUDGET`
- live chain lifecycle from the configured RPC failover provider
- latest `PUT /agent-status` row for the agent
- final review/audit artifacts, when present
- recent agent context events, including status transitions and artifact writes
- recent Q&A pairs for the same `(requestId, agent, sessionId)`

Hidden chain-of-thought is not stored, exposed, or used as raw text. The prompt
does include persisted structured rationales, artifact summaries, status/event
logs, and prior Q&A in the selected session.

Request body:

```json
{
  "question": "What did you decide so far, and what is still unknown?",
  "sessionId": "default"
}
```

Fields:

| Field | Required | Notes |
| --- | --- | --- |
| `question` | yes | Non-empty user question. |
| `sessionId` | no | Defaults to `"default"`. History is isolated by `requestId + agent + sessionId`. |

Response:

```json
{
  "requestId": "13",
  "agent": "0x66ff396457F3df77c6d520f0f3BBb05e4794E057",
  "sessionId": "live-e2e",
  "answer": "Review stage: I assigned weak_accept with score 6200...",
  "confidence": 9700,
  "contextUsed": {
    "hasDocument": true,
    "hasReview": true,
    "hasAudit": true,
    "agentStatus": "Finalized:finalized",
    "historyUsed": 3,
    "eventsUsed": 17,
    "chainStatus": "Finalized"
  },
  "model": "gpt-oss-120b",
  "usage": {
    "promptTokens": 0,
    "completionTokens": 0,
    "totalTokens": 0
  },
  "createdAt": 1777810044
}
```

Error responses:

| Status | Error | Meaning |
| --- | --- | --- |
| `400` | `invalid_params` or `invalid_agent_question` | Bad request id, bad agent address, or invalid body. |
| `404` | `not_found` | No document, status, artifact, event, or chain context exists for that request/agent. |
| `503` | `agent_qa_unavailable` | The LLM call or JSON response parsing failed. |

Live Sepolia example from 2026-05-03:

```bash
curl -sS \
  -H 'Content-Type: application/json' \
  -d '{
    "sessionId": "live-e2e",
    "question": "Summarize your final review and audit judgment."
  }' \
  http://127.0.0.1:18002/requests/13/agents/0x66ff396457F3df77c6d520f0f3BBb05e4794E057/ask
```

Observed response excerpt:

```json
{
  "requestId": "13",
  "agent": "0x66ff396457F3df77c6d520f0f3BBb05e4794E057",
  "sessionId": "live-e2e",
  "confidence": 9700,
  "contextUsed": {
    "hasDocument": true,
    "hasReview": true,
    "hasAudit": true,
    "agentStatus": "Finalized:finalized",
    "historyUsed": 2,
    "eventsUsed": 16,
    "chainStatus": "Finalized"
  },
  "answer": "Review stage: weak_accept, score 6200, confidence 7200. The request has finalized and audit context is available..."
}
```

The same request was also queried during `ReviewCommit`, before review/audit
artifacts existed. The response succeeded with:

```json
{
  "contextUsed": {
    "hasDocument": true,
    "hasReview": false,
    "hasAudit": false,
    "agentStatus": "ReviewCommit:running",
    "historyUsed": 0,
    "eventsUsed": 2,
    "chainStatus": "ReviewCommit"
  }
}
```

### `GET /requests/:requestId/agents/:agent/qa-history`

Returns stored Q&A rows for one request, agent, and session. `:agent` must be an
Ethereum address.

Query parameters:

| Field | Default | Notes |
| --- | --- | --- |
| `sessionId` | `default` | Reads only this session's history. |
| `limit` | `20` | Maximum rows to return for display/debug. |

Response:

```json
{
  "requestId": "13",
  "agent": "0x66ff396457F3df77c6d520f0f3BBb05e4794E057",
  "sessionId": "live-e2e",
  "history": [
    {
      "id": 42,
      "requestId": "13",
      "agent": "0x66ff396457F3df77c6d520f0f3BBb05e4794E057",
      "sessionId": "live-e2e",
      "question": "Summarize your final review and audit judgment.",
      "answer": "...",
      "confidence": 9700,
      "contextUsed": {
        "hasDocument": true,
        "hasReview": true,
        "hasAudit": true,
        "agentStatus": "Finalized:finalized",
        "historyUsed": 3,
        "eventsUsed": 17,
        "chainStatus": "Finalized"
      },
      "model": "gpt-oss-120b",
      "usage": {
        "promptTokens": 0,
        "completionTokens": 0,
        "totalTokens": 0
      },
      "createdAt": 1777810044
    }
  ]
}
```

The prompt context window for prior Q&A pairs is controlled by
`CONTENT_AGENT_QA_HISTORY_WINDOW`; the default is `3`. A live Sepolia smoke test
with four questions in `sessionId=live-e2e` stored four rows, while the final
answer used `historyUsed=3`. A separate `sessionId=live-e2e-other` started with
`historyUsed=0`.

### `POST /requests/:requestId/agents/:agent/score-report`

Generates, stores, and returns a finalized score report for one agent. The
server first verifies `DAIOCore.getRequestLifecycle(requestId)` from the
configured chain RPC. If the request is not `Finalized`, it returns `409`. If a
cached report already exists for `(requestId, agent)`, it returns that report
without another LLM call.

The report uses the same structured context family as `/ask`, but it is not
stored in Q&A history. It is stored in `agent_score_reports`, and a
`score_report_generated` event is appended to the agent context event log.
The endpoint may mention off-chain artifacts as caveats, but `scoreGiven`,
`auditGiven`, and `participation` are derived from on-chain accepted
review/audit participants for the finalized attempt. If an agent produced a
local review artifact after quorum moved on and the contract did not accept the
commit/reveal, `scoreGiven` is `null` and participation is `skipped`.

Request body: empty.

Response:

```json
{
  "requestId": "18",
  "agent": "0x66ff396457F3df77c6d520f0f3BBb05e4794E057",
  "cached": false,
  "report": {
    "schema": "daio.agent.score_report.v1",
    "request": {
      "requestId": "18",
      "chainStatus": "Finalized",
      "finalScore": 6200,
      "lowConfidence": false,
      "retryCount": "0"
    },
    "agent": {
      "address": "0x66ff396457F3df77c6d520f0f3BBb05e4794E057",
      "latestStatus": "Finalized:finalized",
      "participation": "reviewer_and_auditor"
    },
    "scoreGiven": {
      "proposalScore": 6200,
      "recommendation": "weak_accept",
      "confidence": 7200,
      "reportHash": "0xad3987d8b07298aada45b8209c2c58f3df5a9c6e09fafcdd96fd6deea9c946c1"
    },
    "auditGiven": {
      "auditHash": "0x...",
      "targetCount": 2,
      "targetEvaluations": []
    },
    "decisionSummary": "...",
    "rationale": {
      "whyThisScore": "...",
      "mainStrengths": [],
      "mainWeaknesses": [],
      "riskFactors": [],
      "confidenceExplanation": "..."
    },
    "evidence": [],
    "caveats": []
  },
  "model": "gpt-oss-120b",
  "usage": {
    "promptTokens": 0,
    "completionTokens": 0,
    "totalTokens": 0
  },
  "createdAt": 1777810044
}
```

`participation` is one of `reviewer_and_auditor`, `reviewer_only`,
`auditor_only`, `skipped`, or `observer`. If the agent was not accepted on-chain
for review or audit in the finalized attempt, `scoreGiven` and/or `auditGiven`
are `null` even when an off-chain artifact exists; the report should explain the
skipped/observer state instead of inventing accepted participation.

Live Sepolia example:

```bash
curl -sS -X POST \
  http://127.0.0.1:18002/requests/18/agents/0x66ff396457F3df77c6d520f0f3BBb05e4794E057/score-report
```

Response excerpt from request `18`:

```json
{
  "cached": false,
  "requestId": "18",
  "report": {
    "request": { "chainStatus": "Finalized", "finalScore": 6200 },
    "agent": { "participation": "reviewer_and_auditor" },
    "scoreGiven": {
      "proposalScore": 6200,
      "recommendation": "weak_accept",
      "confidence": 7200
    },
    "auditGiven": { "targetCount": 2 }
  }
}
```

Skipped-agent excerpt from the same finalized request:

```bash
curl -sS -X POST \
  http://127.0.0.1:18002/requests/18/agents/0x08913F98a37FCC24CB825fB6db7599086A5f8f56/score-report
```

```json
{
  "cached": false,
  "requestId": "18",
  "report": {
    "agent": { "participation": "skipped" },
    "scoreGiven": null,
    "auditGiven": null,
    "caveats": [
      "The agent's off-chain review score (6200) is not counted because the contract did not accept this agent as a finalized review participant."
    ]
  }
}
```

Error responses:

| Status | Error | Meaning |
| --- | --- | --- |
| `400` | `invalid_params` | Bad request id or bad agent address. |
| `404` | `not_found` | No agent-specific status, artifact, or event context exists. |
| `409` | `request_not_finalized` | The contract lifecycle is not `Finalized`. |
| `503` | `chain_status_unavailable` | Chain lifecycle or round aggregate reads failed. |
| `503` | `score_report_unavailable` | LLM generation or schema validation failed. |

### `POST /requests/:requestId/final-report`

Generates, stores, and returns a request-level final report. The server verifies
the request is finalized, uses all agents present in `agent_status` for that
request, generates any missing per-agent score reports, and then synthesizes a
single JSON report. The `agentCount` is the number of tracked status agents, but
proposal score fields inside `agentReports` are populated only for on-chain
accepted review participants. Cached final reports are returned without another
LLM call.

Request body: empty.

Response:

```json
{
  "requestId": "18",
  "cached": false,
  "agentCount": 5,
  "report": {
    "schema": "daio.request.final_report.v1",
    "request": {
      "requestId": "18",
      "chainStatus": "Finalized",
      "finalScore": 6200,
      "lowConfidence": false,
      "retryCount": "0"
    },
    "agentReports": [
      {
        "agent": "0x66ff396457F3df77c6d520f0f3BBb05e4794E057",
        "participation": "reviewer_and_auditor",
        "proposalScore": 6200,
        "recommendation": "weak_accept",
        "confidence": 7200
      },
      {
        "agent": "0x08913F98a37FCC24CB825fB6db7599086A5f8f56",
        "participation": "skipped",
        "proposalScore": null,
        "recommendation": null,
        "confidence": null
      }
    ],
    "consensus": {
      "summary": "...",
      "agreementLevel": "high",
      "scoreSpread": "...",
      "notableDisagreements": []
    },
    "finalAssessment": {
      "executiveSummary": "...",
      "scoreRationale": "...",
      "mainStrengths": [],
      "mainWeaknesses": [],
      "auditFindings": [],
      "operationalNotes": []
    },
    "caveats": []
  },
  "model": "gpt-oss-120b",
  "usage": {
    "promptTokens": 0,
    "completionTokens": 0,
    "totalTokens": 0
  },
  "createdAt": 1777810044
}
```

Live Sepolia example:

```bash
curl -sS -X POST http://127.0.0.1:18002/requests/18/final-report
```

Response excerpt:

```json
{
  "cached": false,
  "requestId": "18",
  "agentCount": 5,
  "report": {
    "request": { "chainStatus": "Finalized", "finalScore": 6200 },
    "consensus": {
      "agreementLevel": "high",
      "scoreSpread": "Proposal scores ranged from 6200 to 6200 across 3 scoring agents."
    },
    "agentReports": [
      {
        "agent": "0x66ff396457F3df77c6d520f0f3BBb05e4794E057",
        "participation": "reviewer_and_auditor",
        "proposalScore": 6200
      },
      {
        "agent": "0x08913F98a37FCC24CB825fB6db7599086A5f8f56",
        "participation": "skipped",
        "proposalScore": null
      }
    ]
  }
}
```

Immediate repeat calls return cached JSON:

```json
{
  "cached": true,
  "requestId": "18",
  "agentCount": 5,
  "report": {
    "request": { "finalScore": 6200 },
    "consensus": {
      "scoreSpread": "Proposal scores ranged from 6200 to 6200 across 3 scoring agents."
    }
  }
}
```

Error responses:

| Status | Error | Meaning |
| --- | --- | --- |
| `400` | `invalid_params` | Bad request id. |
| `404` | `not_found` | No agent statuses exist for this finalized request. |
| `409` | `request_not_finalized` | The contract lifecycle is not `Finalized`. |
| `503` | `chain_status_unavailable` | Chain lifecycle or round aggregate reads failed. |
| `503` | `final_report_unavailable` | Agent report generation, final LLM generation, or schema validation failed. |

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
| `GET` | `/proposals/:id/markdown` | Read the stored proposal Markdown as JSON, or raw Markdown with `?format=raw`. |
| `POST` | `/reports` | Agent-only. Store canonical review artifact; with signature enforcement, body is `{ artifact, signature }`. |
| `GET` | `/reports/:hash` | Read a stored review artifact. |
| `POST` | `/audits` | Agent-only. Store canonical audit artifact; with signature enforcement, body is `{ artifact, signature }`. |
| `GET` | `/audits/:hash` | Read a stored audit artifact. |
| `PUT` | `/agent-status` | Agent-only status writer; with signature enforcement, body includes `signature`. Frontends should normally read status endpoints instead. |
| `POST` | `/requests/:requestId/agents/:agent/ask` | Public Q&A reader backed by the LLM and persisted request/agent context. |
| `GET` | `/requests/:requestId/agents/:agent/qa-history` | Public Q&A history reader for one session. |
| `POST` | `/requests/:requestId/agents/:agent/score-report` | Public cached finalized score report generator/reader for one agent. |
| `POST` | `/requests/:requestId/final-report` | Public cached finalized request report generator/reader. |

Proposal response shape for `POST /proposals` and `GET /proposals/:id`:

```json
{
  "uri": "content://proposals/paper-001",
  "id": "paper-001",
  "hash": "0x...",
  "mimeType": "text/markdown",
  "text": "# Document markdown"
}
```

Review artifact response shape for `POST /reports` and `GET /reports/:hash`:

```json
{
  "uri": "content://reports/0x...",
  "hash": "0x...",
  "artifact": {
    "schema": "daio.review.artifact.v1",
    "requestId": "1",
    "reviewer": "0xReviewer",
    "proposalScore": 6200,
    "report": {
      "summary": "...",
      "rubricAssessments": [
        {
          "criterion": "Novelty",
          "score": 6100,
          "rationale": "..."
        }
      ],
      "strengths": [],
      "weaknesses": [],
      "risks": [],
      "recommendation": "borderline",
      "confidence": 8200
    },
    "source": {
      "proposalURI": "content://proposals/paper-001",
      "proposalHash": "0x...",
      "rubricHash": "0x..."
    },
    "metadata": {}
  }
}
```

Audit artifact response shape for `POST /audits` and `GET /audits/:hash`:

```json
{
  "uri": "content://audits/0x...",
  "hash": "0x...",
  "artifact": {
    "schema": "daio.audit.artifact.v1",
    "requestId": "1",
    "auditor": "0xAuditor",
    "targets": ["0xReviewer"],
    "scores": [7800],
    "rationales": ["..."],
    "source": {
      "proposalURI": "content://proposals/paper-001",
      "proposalHash": "0x..."
    },
    "metadata": {}
  }
}
```

For signed artifact writes, the server recomputes `hash` from canonical JSON and
verifies the wallet signature before persisting.

## Contract Views

Use the deployment snapshot, usually `./.deployments/sepolia.json`, for contract addresses. The frontend should construct ethers/viem contracts with the ABI artifacts under `contracts/artifacts`. The current Sepolia snapshot points `ConsensusScoring` at `0xe271d90C72D9a8D931f337C144C6C4e204F994ed`; older integrations that cached `0xEf348E9658087F7F459dE35207EF02bEb6923aaE` should refresh from the snapshot.

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

Interpretation notes:

- Contract views/events are the settlement source of truth for lifecycle status,
  participant acceptance, finalized scores, rewards, and slashing.
- Content API records are off-chain convenience data for documents, final
  rationales, current agent observability, agent-scoped Q&A, and cached final
  report JSON. They can lag chain events during processing.
- Current `ConsensusScoring` credits a reviewer with normalized audit
  reliability when their report has zero incoming audits, so honest audit work
  is not discarded just because peers missed their audit obligations. Reviewers
  with no incoming audits and no completed audit work still receive zero weight.
- `GET /requests/:requestId/markdown` is the canonical off-chain document body
  for a request; its `proposal.hash` equals the on-chain `proposalHash`.
- The reasons endpoint intentionally reports `rawThinking.available=false`.
  Hidden chain-of-thought is not persisted or exposed. The Q&A endpoint uses
  structured artifacts, status events, and stored summaries instead.

### `ReviewerRegistry`

| View | Returns | Frontend use |
| --- | --- | --- |
| `getReviewer(address reviewer)` | `(registered, active, suspended, agentId, stake, domainMask, completedRequests, semanticStrikes, protocolFaults, cooldownUntilBlock, ensNode, ensName)` | Reviewer profile. |
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
| `verifiedCanonicalAuditTargets(...)` | `(bool ok, address[] selectedTargets)` | Debug full-audit assignment preview; pass empty target proofs. |
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
- `GET /requests/:requestId/markdown`
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
- `POST /requests/:requestId/agents/:agent/ask`
- `GET /requests/:requestId/agents/:agent/qa-history?sessionId=default`
