import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { getAddress, Interface, NonceManager, Wallet, keccak256, toUtf8Bytes, type Provider } from "ethers";
import { z } from "zod";
import { ContentDB } from "./db.js";
import { ReviewArtifact, AuditArtifact } from "../shared/schemas.js";
import { canonicalHash, canonicalJson } from "../shared/canonical.js";
import { agentArtifactMessage, agentStatusMessage, verifyAgentSignature } from "../shared/agent-signing.js";
import { Artifacts } from "../shared/abis.js";
import type { DeploymentSnapshot } from "../shared/types.js";
import { RequestStatus, Tier } from "../shared/types.js";
import { loadContracts } from "../reviewer-agent/chain/contracts.js";
import {
  makeRpcProvider,
  parseRpcUrls,
  rpcFailoverOptionsFromEnv,
  txFinalityConfirmationsFromEnv,
  waitForTransactionHashWithRetries,
  waitForTransactionWithRetries,
  withRpcReadRetries,
} from "../shared/rpc.js";
import {
  buildPromptCacheMessages,
  chat,
  chatJsonWithRetry,
  configuredModelName,
  type ChatMessage,
} from "../reviewer-agent/llm/client.js";
import { budgetProposal } from "../reviewer-agent/llm/prepareInput.js";

export interface ServerOptions {
  dbPath: string;
  logger?: boolean;
  chain?: {
    rpcUrl?: string;
    rpcUrls?: string;
    deploymentPath?: string;
  };
  relayer?: {
    privateKey?: string;
    confirmations?: number;
  };
  requireAgentSignatures?: boolean;
}

interface CorsConfig {
  allowOrigin: string;
  allowMethods: string;
  allowHeaders: string;
  exposeHeaders: string;
  maxAge: string;
  allowCredentials: boolean;
}

function envSetting(names: readonly string[], fallback: string): string {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function corsConfigFromEnv(): CorsConfig {
  return {
    allowOrigin: envSetting(["CONTENT_CORS_ALLOW_ORIGIN", "CORS_ALLOW_ORIGIN"], "*"),
    allowMethods: envSetting(
      ["CONTENT_CORS_ALLOW_METHODS", "CORS_ALLOW_METHODS"],
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    ),
    allowHeaders: envSetting(
      ["CONTENT_CORS_ALLOW_HEADERS", "CORS_ALLOW_HEADERS"],
      "Content-Type,Authorization,X-Requested-With,X-Filename",
    ),
    exposeHeaders: envSetting(["CONTENT_CORS_EXPOSE_HEADERS", "CORS_EXPOSE_HEADERS"], "Content-Length,Content-Type"),
    maxAge: envSetting(["CONTENT_CORS_MAX_AGE", "CORS_MAX_AGE"], "86400"),
    allowCredentials: boolEnv("CONTENT_CORS_ALLOW_CREDENTIALS", boolEnv("CORS_ALLOW_CREDENTIALS", false)),
  };
}

function resolveAllowedOrigin(config: CorsConfig, requestOrigin: string | undefined): string | undefined {
  const entries = config.allowOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (entries.includes("*")) {
    return config.allowCredentials ? requestOrigin : "*";
  }
  if (requestOrigin && entries.includes(requestOrigin)) return requestOrigin;
  return undefined;
}

function installCors(app: FastifyInstance, config: CorsConfig): void {
  app.addHook("onRequest", async (req, reply) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const allowedOrigin = resolveAllowedOrigin(config, origin);
    if (allowedOrigin) {
      reply.header("Access-Control-Allow-Origin", allowedOrigin);
      if (allowedOrigin !== "*") reply.header("Vary", "Origin");
    }
    reply.header("Access-Control-Allow-Methods", config.allowMethods);
    reply.header(
      "Access-Control-Allow-Headers",
      typeof req.headers["access-control-request-headers"] === "string"
        ? req.headers["access-control-request-headers"]
        : config.allowHeaders,
    );
    reply.header("Access-Control-Expose-Headers", config.exposeHeaders);
    reply.header("Access-Control-Max-Age", config.maxAge);
    if (config.allowCredentials) reply.header("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      reply.code(204).send();
    }
  });
}

const HexAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const HexTxHash = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const HexBytes32 = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const HexSignature = z.string().regex(/^0x[a-fA-F0-9]{130}$/);
const DecimalId = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform((v) => String(v));
const UintString = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((v) => String(v));

const SubmitDocumentBody = z.object({
  txHash: HexTxHash,
  requester: HexAddress.optional(),
  id: z.string().min(1).max(200).optional(),
  text: z.string().min(1),
  mimeType: z.string().min(1).max(120).optional(),
});

const AgentStatusBody = z.object({
  requestId: DecimalId,
  agent: HexAddress,
  phase: z.string().min(1).max(80),
  status: z.string().min(1).max(80),
  detail: z.string().max(1000).optional(),
  payload: z.record(z.unknown()).optional().default({}),
  signature: HexSignature.optional(),
});

const AgentAskBody = z.object({
  question: z.string().min(1).max(8000),
  sessionId: z.string().min(1).max(120).default("default"),
});

const AgentQaHistoryQuery = z.object({
  sessionId: z.string().min(1).max(120).default("default"),
  limit: z.preprocess((value) => (value === undefined ? 20 : Number(value)), z.number().int().min(1).max(100)),
});

const AgentQaModelResponse = z.object({
  answer: z.string().min(1),
  confidence: z.number().int().min(0).max(10000).default(0),
});

const Score = z.number().int().min(0).max(10000);
const AgentParticipation = z.enum(["reviewer_and_auditor", "reviewer_only", "auditor_only", "skipped", "observer"]);
function stringList(maxItems: number, maxLength: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.map((item) => String(item)).filter((item) => item.trim() !== "");
    if (typeof value === "string") return value.trim() === "" ? [] : [value];
    if (typeof value === "object") {
      return Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => `${key}: ${String(item)}`)
        .filter((item) => item.trim() !== "");
    }
    return [String(value)];
  }, z.array(z.string().min(1).max(maxLength)).max(maxItems).default([]));
}

function stringFromObject(value: Record<string, unknown>, names: readonly string[], fallback: string): string {
  for (const name of names) {
    const item = value[name];
    if (typeof item === "string" && item.trim() !== "") return item;
  }
  return fallback;
}

function agreementLevel(value: unknown): z.infer<typeof RequestFinalAgreementLevel> {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (text.includes("high") || text.includes("strong")) return "high";
  if (text.includes("moderate") || text.includes("medium")) return "moderate";
  if (text.includes("low") || text.includes("weak")) return "low";
  return "mixed";
}

const ScoreGiven = z
  .object({
    proposalScore: Score,
    recommendation: z.string().min(1).max(120),
    confidence: Score,
    reportHash: HexBytes32,
  })
  .nullable();
const AuditGiven = z
  .object({
    auditHash: HexBytes32,
    targetCount: z.number().int().min(0).max(100),
    targetEvaluations: z.array(
      z.object({
        targetReviewer: HexAddress,
        score: Score,
        rationale: z.string().min(1).max(2000),
      }),
    ),
  })
  .nullable();
const AgentScoreRationale = z.preprocess(
  (value) => {
    if (typeof value === "string") {
      return {
        whyThisScore: value,
        mainStrengths: [],
        mainWeaknesses: [],
        riskFactors: [],
        confidenceExplanation: value,
      };
    }
    return value;
  },
  z.object({
    whyThisScore: z.string().min(1).max(4000),
    mainStrengths: stringList(12, 800),
    mainWeaknesses: stringList(12, 800),
    riskFactors: stringList(12, 800),
    confidenceExplanation: z.string().min(1).max(2000),
  }),
);
const RequestFinalAgreementLevel = z.enum(["high", "moderate", "low", "mixed"]);
const RequestFinalConsensus = z.preprocess(
  (value) => {
    if (typeof value === "string") {
      return {
        summary: value,
        agreementLevel: "mixed",
        scoreSpread: "Score spread was not specified by the model.",
        notableDisagreements: [],
      };
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      return {
        ...obj,
        summary: stringFromObject(
          obj,
          ["summary", "consensusSummary", "assessment", "analysis", "description"],
          "Consensus summary was not specified by the model.",
        ),
        agreementLevel: agreementLevel(obj.agreementLevel ?? obj.agreement ?? obj.level),
        scoreSpread: stringFromObject(
          obj,
          ["scoreSpread", "spread", "scoreDistribution", "scoreVariance"],
          "Score spread was not specified by the model.",
        ),
        notableDisagreements: obj.notableDisagreements ?? obj.disagreements ?? [],
      };
    }
    return value;
  },
  z.object({
    summary: z.string().min(1).max(4000),
    agreementLevel: RequestFinalAgreementLevel,
    scoreSpread: z.string().min(1).max(1000),
    notableDisagreements: stringList(20, 1000),
  }),
);
const RequestFinalAssessment = z.preprocess(
  (value) => {
    if (typeof value === "string") {
      return {
        executiveSummary: value,
        scoreRationale: value,
        mainStrengths: [],
        mainWeaknesses: [],
        auditFindings: [],
        operationalNotes: [],
      };
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      return {
        ...obj,
        executiveSummary: stringFromObject(
          obj,
          ["executiveSummary", "summary", "finalSummary", "assessment"],
          "Executive summary was not specified by the model.",
        ),
        scoreRationale: stringFromObject(
          obj,
          ["scoreRationale", "rationale", "finalScoreRationale", "whyThisScore"],
          "Score rationale was not specified by the model.",
        ),
        mainStrengths: obj.mainStrengths ?? obj.strengths ?? [],
        mainWeaknesses: obj.mainWeaknesses ?? obj.weaknesses ?? [],
        auditFindings: obj.auditFindings ?? obj.findings ?? [],
        operationalNotes: obj.operationalNotes ?? obj.notes ?? [],
      };
    }
    return value;
  },
  z.object({
    executiveSummary: z.string().min(1).max(4000),
    scoreRationale: z.string().min(1).max(4000),
    mainStrengths: stringList(12, 800),
    mainWeaknesses: stringList(12, 800),
    auditFindings: stringList(20, 1000),
    operationalNotes: stringList(20, 1000),
  }),
);

const AgentScoreReportModelResponse = z.object({
  schema: z.literal("daio.agent.score_report.v1"),
  request: z.object({
    requestId: z.string().regex(/^\d+$/),
    chainStatus: z.string().min(1).max(80),
    finalScore: Score,
    lowConfidence: z.boolean(),
    retryCount: z.string().regex(/^\d+$/),
  }),
  agent: z.object({
    address: HexAddress,
    latestStatus: z.string().min(1).max(200).nullable(),
    participation: AgentParticipation,
  }),
  scoreGiven: ScoreGiven,
  auditGiven: AuditGiven,
  decisionSummary: z.string().min(1).max(4000),
  rationale: AgentScoreRationale,
  evidence: stringList(20, 1000),
  caveats: stringList(20, 1000),
});
type AgentScoreReport = z.infer<typeof AgentScoreReportModelResponse>;

const RequestFinalReportModelResponse = z.object({
  schema: z.literal("daio.request.final_report.v1"),
  request: z.object({
    requestId: z.string().regex(/^\d+$/),
    chainStatus: z.string().min(1).max(80),
    finalScore: Score,
    lowConfidence: z.boolean(),
    retryCount: z.string().regex(/^\d+$/),
  }),
  agentReports: z.array(
    z.object({
      agent: HexAddress,
      participation: AgentParticipation,
      proposalScore: Score.nullable(),
      recommendation: z.string().min(1).max(120).nullable(),
      confidence: Score.nullable(),
    }),
  ),
  consensus: RequestFinalConsensus,
  finalAssessment: RequestFinalAssessment,
  caveats: stringList(20, 1000),
});
type RequestFinalReport = z.infer<typeof RequestFinalReportModelResponse>;

const ReviewArtifactBody = z.union([
  ReviewArtifact,
  z.object({
    artifact: ReviewArtifact,
    signature: HexSignature,
  }),
]);

const AuditArtifactBody = z.union([
  AuditArtifact,
  z.object({
    artifact: AuditArtifact,
    signature: HexSignature,
  }),
]);

const RequestIntentBody = z.object({
  requester: HexAddress,
  id: z.string().min(1).max(200).optional(),
  proposalURI: z.string().min(1).max(500).optional(),
  text: z.string().min(1),
  rubricHash: HexBytes32.optional(),
  domainMask: UintString.default("1"),
  tier: z.number().int().min(0).max(2).default(0),
  priorityFee: UintString.default("0"),
  deadline: UintString.optional(),
  mimeType: z.string().min(1).max(120).optional(),
});

const RelayedDocumentBody = RequestIntentBody.extend({
  deadline: UintString,
  signature: HexSignature,
});

const REQUEST_INTENT_TYPES = {
  RequestIntent: [
    { name: "requester", type: "address" },
    { name: "proposalURIHash", type: "bytes32" },
    { name: "proposalHash", type: "bytes32" },
    { name: "rubricHash", type: "bytes32" },
    { name: "domainMask", type: "uint256" },
    { name: "tier", type: "uint8" },
    { name: "priorityFee", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const RAW_THINKING_NOTICE = {
  available: false,
  reason:
    "Raw hidden model reasoning is not stored or exposed. This API returns the model's final structured rationales and raw final artifacts.",
};

function addressKey(address: string): string {
  return getAddress(address).toLowerCase();
}

function loadDeploymentSnapshot(deploymentPath: string): DeploymentSnapshot {
  if (!existsSync(deploymentPath)) {
    throw new Error(`deployment snapshot not found at ${deploymentPath}`);
  }
  return JSON.parse(readFileSync(deploymentPath, "utf8")) as DeploymentSnapshot;
}

function proposalIdFromUri(uri: string): string | undefined {
  const m = uri.match(/^content:\/\/proposals\/(.+)$/);
  return m?.[1];
}

function normalizeProposalReference(input: { id?: string; proposalURI?: string }) {
  const proposalURI = input.proposalURI ?? (input.id ? `content://proposals/${input.id}` : undefined);
  if (!proposalURI) return { ok: false as const, error: "id_or_proposal_uri_required" };
  const idFromUri = proposalIdFromUri(proposalURI);
  if (!idFromUri) return { ok: false as const, error: "unsupported_proposal_uri", proposalURI };
  if (input.id && input.id !== idFromUri) {
    return { ok: false as const, error: "proposal_id_mismatch", expected: idFromUri, got: input.id };
  }
  return { ok: true as const, id: idFromUri, proposalURI };
}

function normalizeRequestIntentFields(input: {
  requester: string;
  id?: string;
  proposalURI?: string;
  text: string;
  rubricHash?: string;
  domainMask: string;
  tier: number;
  priorityFee: string;
  deadline?: string;
}) {
  const ref = normalizeProposalReference(input);
  if (!ref.ok) return ref;
  const proposalHash = keccak256(toUtf8Bytes(input.text));
  const rubricHash = input.rubricHash ?? keccak256(toUtf8Bytes(`${ref.id}:rubric`));
  return {
    ok: true as const,
    requester: getAddress(input.requester),
    id: ref.id,
    proposalURI: ref.proposalURI,
    proposalURIHash: keccak256(toUtf8Bytes(ref.proposalURI)),
    proposalHash,
    rubricHash,
    domainMask: input.domainMask,
    tier: input.tier,
    priorityFee: input.priorityFee,
    deadline: input.deadline,
  };
}

function serializeAgentStatus(row: ReturnType<ContentDB["getAgentStatus"]>) {
  if (!row) return undefined;
  return {
    requestId: row.requestId,
    agent: row.agent,
    phase: row.phase,
    status: row.status,
    detail: row.detail,
    payload: JSON.parse(row.payloadJson) as unknown,
    updatedAt: row.updatedAt,
  };
}

function parseStoredJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch (_err) {
    return { _invalidJson: true };
  }
}

function serializeAgentContextEvent(row: ReturnType<ContentDB["listAgentContextEvents"]>[number]) {
  return {
    id: row.id,
    requestId: row.requestId,
    agent: row.agent,
    eventType: row.eventType,
    phase: row.phase,
    status: row.status,
    detail: row.detail,
    payload: parseStoredJson(row.payloadJson),
    createdAt: row.createdAt,
  };
}

function serializeAgentQaHistory(row: ReturnType<ContentDB["listAgentQaHistory"]>[number]) {
  return {
    id: row.id,
    requestId: row.requestId,
    agent: row.agent,
    sessionId: row.sessionId,
    question: row.question,
    answer: row.answer,
    confidence: row.confidence,
    contextUsed: parseStoredJson(row.contextSummaryJson),
    model: row.model,
    usage: {
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
    },
    createdAt: row.createdAt,
  };
}

function serializeRequestDocument(db: ContentDB, requestId: string) {
  const row = db.getRequestDocument(requestId);
  if (!row) return undefined;
  const proposal = db.getProposal(row.proposalId);
  if (!proposal) return undefined;
  return {
    updatedAt: row.updatedAt,
    verified: {
      requestId: row.requestId,
      requester: row.requester,
      proposalURI: row.proposalUri,
      proposalHash: row.proposalHash,
      rubricHash: row.rubricHash,
      domainMask: row.domainMask,
      tier: row.tier,
      tierName: Tier[row.tier] ?? `Tier${row.tier}`,
      priorityFee: row.priorityFee,
      txHash: row.paymentTxHash,
      paymentFunction: row.paymentFunction,
      paymentToken: row.paymentToken,
      amountPaid: row.amountPaid,
      blockNumber: row.blockNumber,
      status: row.status,
      statusName: row.statusName,
    },
    proposal: {
      uri: row.proposalUri,
      id: proposal.id,
      hash: proposal.hash,
      mimeType: proposal.mimeType,
      text: proposal.text,
    },
  };
}

function markdownResponse(input: { uri: string; id: string; hash: string; mimeType: string; text: string }) {
  return {
    uri: input.uri,
    id: input.id,
    hash: input.hash,
    mimeType: input.mimeType,
    bytes: Buffer.byteLength(input.text, "utf8"),
    markdown: input.text,
  };
}

function wantsRawMarkdown(req: { headers: { accept?: string }; query?: { format?: string } }): boolean {
  const format = req.query?.format?.trim().toLowerCase();
  if (format && ["raw", "text", "markdown"].includes(format)) return true;
  const accept = req.headers.accept?.toLowerCase() ?? "";
  return accept.includes("text/markdown") && !accept.includes("application/json");
}

function sendRawMarkdown(
  reply: { type: (value: string) => unknown; header: (name: string, value: string) => unknown },
  input: { uri: string; hash: string; text: string },
) {
  reply.type("text/markdown; charset=utf-8");
  reply.header("ETag", `"${input.hash}"`);
  reply.header("X-DAIO-Proposal-URI", input.uri);
  reply.header("X-DAIO-Proposal-Hash", input.hash);
  return input.text;
}

function findReviewArtifact(db: ContentDB, requestId: string, agent: string) {
  const key = addressKey(agent);
  const indexed = db.findReviewArtifact(requestId, key);
  if (indexed) return indexed;
  for (const row of db.listBlobs("reports")) {
    const parsed = ReviewArtifact.safeParse(JSON.parse(row.json));
    if (parsed.success && parsed.data.requestId === requestId && addressKey(parsed.data.reviewer) === key) {
      db.indexReviewArtifact({ requestId, reviewerKey: key, reviewer: getAddress(parsed.data.reviewer), hash: row.hash });
      return row;
    }
  }
  return undefined;
}

function findAuditArtifact(db: ContentDB, requestId: string, agent: string) {
  const key = addressKey(agent);
  const indexed = db.findAuditArtifact(requestId, key);
  if (indexed) return indexed;
  for (const row of db.listBlobs("audits")) {
    const parsed = AuditArtifact.safeParse(JSON.parse(row.json));
    if (parsed.success && parsed.data.requestId === requestId && addressKey(parsed.data.auditor) === key) {
      db.indexAuditArtifact({ requestId, auditorKey: key, auditor: getAddress(parsed.data.auditor), hash: row.hash });
      return row;
    }
  }
  return undefined;
}

function buildAgentReasons(db: ContentDB, requestId: string, agent: string) {
  const normalizedAgent = getAddress(agent);
  const reviewRow = findReviewArtifact(db, requestId, normalizedAgent);
  const auditRow = findAuditArtifact(db, requestId, normalizedAgent);
  const reviewArtifact = reviewRow ? ReviewArtifact.parse(JSON.parse(reviewRow.json)) : undefined;
  const auditArtifact = auditRow ? AuditArtifact.parse(JSON.parse(auditRow.json)) : undefined;

  return {
    requestId,
    agent: normalizedAgent,
    rawThinking: RAW_THINKING_NOTICE,
    review: reviewArtifact
      ? {
          reportHash: reviewRow!.hash,
          proposalScore: reviewArtifact.proposalScore,
          summary: reviewArtifact.report.summary,
          recommendation: reviewArtifact.report.recommendation,
          confidence: reviewArtifact.report.confidence,
          rubricAssessments: reviewArtifact.report.rubricAssessments,
          strengths: reviewArtifact.report.strengths,
          weaknesses: reviewArtifact.report.weaknesses,
          risks: reviewArtifact.report.risks,
          rawFinalArtifact: reviewArtifact,
        }
      : null,
    audit: auditArtifact
      ? {
          auditHash: auditRow!.hash,
          targetEvaluations: auditArtifact.targets.map((targetReviewer, i) => ({
            targetReviewer,
            score: auditArtifact.scores[i],
            rationale: auditArtifact.rationales[i] ?? "",
          })),
          rawFinalArtifact: auditArtifact,
        }
      : null,
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function requireValidAgentSignature(input: {
  enabled: boolean;
  signer: string;
  message: string;
  signature?: string;
}): { ok: true } | { ok: false; code: number; error: string } {
  if (!input.enabled) return { ok: true };
  if (!input.signature) return { ok: false, code: 401, error: "agent_signature_required" };
  try {
    if (!verifyAgentSignature(input.signer, input.message, input.signature)) {
      return { ok: false, code: 403, error: "agent_signature_mismatch" };
    }
  } catch (err) {
    return { ok: false, code: 400, error: "invalid_agent_signature" };
  }
  return { ok: true };
}

function isNonceError(err: unknown): boolean {
  const text = formatError(err).toLowerCase();
  return text.includes("nonce") || text.includes("replacement transaction underpriced") || text.includes("already known");
}

async function verifyRequestTransaction(input: {
  requestId: string;
  txHash: string;
  requester?: string;
  textHash: string;
  deploymentPath: string;
  rpcUrl?: string;
  rpcUrls?: string;
}) {
  const deployment = loadDeploymentSnapshot(input.deploymentPath);
  const rpcUrls = parseRpcUrls(input.rpcUrl ?? deployment.rpcUrl, input.rpcUrls);
  const provider = makeRpcProvider(rpcUrls, rpcFailoverOptionsFromEnv());
  const paymentRouterAddress = getAddress(deployment.contracts.paymentRouter);
  const iface = new Interface(Artifacts.PaymentRouter().abi as never[]);
  const receipt = await waitForTransactionHashWithRetries(provider, input.txHash);
  if (!receipt) return { ok: false as const, code: 404, error: "tx_not_found_pending_or_unfinalized" };
  if (receipt.status !== 1) return { ok: false as const, code: 400, error: "tx_failed" };

  const tx = await withRpcReadRetries(() => provider.getTransaction(input.txHash));
  if (!tx) return { ok: false as const, code: 404, error: "tx_not_found" };
  if (!tx.to || getAddress(tx.to) !== paymentRouterAddress) {
    return { ok: false as const, code: 400, error: "tx_not_sent_to_payment_router" };
  }

  const parsedTx = iface.parseTransaction({ data: tx.data, value: tx.value });
  if (!parsedTx) return { ok: false as const, code: 400, error: "unsupported_payment_router_call" };

  let proposalURI: string;
  let proposalHash: string;
  let rubricHash: string;
  let domainMask: bigint;
  let tier: number;
  let priorityFee: bigint;
  let expectedRequester: string;
  switch (parsedTx.name) {
    case "createRequestWithUSDAIO":
      proposalURI = String(parsedTx.args[0]);
      proposalHash = String(parsedTx.args[1]);
      rubricHash = String(parsedTx.args[2]);
      domainMask = BigInt(parsedTx.args[3]);
      tier = Number(parsedTx.args[4]);
      priorityFee = BigInt(parsedTx.args[5]);
      expectedRequester = getAddress(tx.from);
      break;
    case "createRequestWithUSDAIOBySig":
      expectedRequester = getAddress(String(parsedTx.args[0]));
      proposalURI = String(parsedTx.args[1]);
      proposalHash = String(parsedTx.args[2]);
      rubricHash = String(parsedTx.args[3]);
      domainMask = BigInt(parsedTx.args[4]);
      tier = Number(parsedTx.args[5]);
      priorityFee = BigInt(parsedTx.args[6]);
      break;
    case "createRequestWithERC20":
      proposalURI = String(parsedTx.args[3]);
      proposalHash = String(parsedTx.args[4]);
      rubricHash = String(parsedTx.args[5]);
      domainMask = BigInt(parsedTx.args[6]);
      tier = Number(parsedTx.args[7]);
      priorityFee = BigInt(parsedTx.args[8]);
      expectedRequester = getAddress(tx.from);
      break;
    case "createRequestWithETH":
      proposalURI = String(parsedTx.args[1]);
      proposalHash = String(parsedTx.args[2]);
      rubricHash = String(parsedTx.args[3]);
      domainMask = BigInt(parsedTx.args[4]);
      tier = Number(parsedTx.args[5]);
      priorityFee = BigInt(parsedTx.args[6]);
      expectedRequester = getAddress(tx.from);
      break;
    default:
      return { ok: false as const, code: 400, error: "unsupported_payment_router_call" };
  }

  if (proposalHash.toLowerCase() !== input.textHash.toLowerCase()) {
    return { ok: false as const, code: 400, error: "proposal_hash_mismatch", onchainProposalHash: proposalHash };
  }

  const paidEvents = receipt.logs.flatMap((log) => {
    if (getAddress(log.address) !== paymentRouterAddress) return [];
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      return parsed?.name === "RequestPaid" ? [parsed] : [];
    } catch (_err) {
      return [];
    }
  });
  const paid = paidEvents.find((event) => String(event.args.requestId) === input.requestId);
  if (!paid) return { ok: false as const, code: 400, error: "request_paid_event_not_found" };

  const txRequester = getAddress(tx.from);
  const eventRequester = getAddress(String(paid.args.requester));
  if (eventRequester !== expectedRequester) {
    return { ok: false as const, code: 400, error: "requester_event_mismatch" };
  }
  if (input.requester && getAddress(input.requester) !== expectedRequester) {
    return { ok: false as const, code: 403, error: "requester_mismatch" };
  }

  const handles = loadContracts(deployment, provider);
  const lifecycle = await withRpcReadRetries(
    () => handles.core.getRequestLifecycle(BigInt(input.requestId)) as Promise<readonly unknown[]>,
  );
  const lifecycleRequester = getAddress(String(lifecycle[0]));
  if (lifecycleRequester !== expectedRequester) {
    return { ok: false as const, code: 400, error: "request_lifecycle_requester_mismatch" };
  }

  return {
    ok: true as const,
    requestId: input.requestId,
    requester: expectedRequester,
    relayer: txRequester === expectedRequester ? undefined : txRequester,
    proposalURI,
    proposalHash,
    rubricHash,
    domainMask: domainMask.toString(),
    tier,
    tierName: Tier[tier] ?? `Tier${tier}`,
    priorityFee: priorityFee.toString(),
    txHash: input.txHash,
    paymentFunction: parsedTx.name,
    paymentToken: String(paid.args.paymentToken),
    amountPaid: String(paid.args.amountPaid),
    blockNumber: receipt.blockNumber,
    status: Number(lifecycle[1]) as RequestStatus,
    statusName: RequestStatus[Number(lifecycle[1])] ?? `Status${Number(lifecycle[1])}`,
  };
}

async function findRequestIdsFromPaymentTx(input: {
  txHash: string;
  requester?: string;
  deploymentPath: string;
  rpcUrl?: string;
  rpcUrls?: string;
}) {
  const deployment = loadDeploymentSnapshot(input.deploymentPath);
  const rpcUrls = parseRpcUrls(input.rpcUrl ?? deployment.rpcUrl, input.rpcUrls);
  const provider = makeRpcProvider(rpcUrls, rpcFailoverOptionsFromEnv());
  const paymentRouterAddress = getAddress(deployment.contracts.paymentRouter);
  const iface = new Interface(Artifacts.PaymentRouter().abi as never[]);
  const receipt = await waitForTransactionHashWithRetries(provider, input.txHash);
  if (!receipt) return { ok: false as const, code: 404, error: "tx_not_found_pending_or_unfinalized" };
  if (receipt.status !== 1) return { ok: false as const, code: 400, error: "tx_failed" };

  const requester = input.requester ? getAddress(input.requester) : undefined;
  const requestIds = receipt.logs.flatMap((log) => {
    if (getAddress(log.address) !== paymentRouterAddress) return [];
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== "RequestPaid") return [];
      if (requester && getAddress(String(parsed.args.requester)) !== requester) return [];
      return [String(parsed.args.requestId)];
    } catch (_err) {
      return [];
    }
  });
  return { ok: true as const, requestIds: [...new Set(requestIds)] };
}

function serializeRequestLifecycle(requestId: string, lifecycle: readonly unknown[]) {
  const status = Number(lifecycle[1] as bigint | number);
  return {
    requestId,
    requester: getAddress(String(lifecycle[0])),
    status,
    statusName: RequestStatus[status] ?? `Status${status}`,
    feePaid: String(lifecycle[2]),
    priorityFee: String(lifecycle[3]),
    retryCount: String(lifecycle[4]),
    committeeEpoch: String(lifecycle[5]),
    auditEpoch: String(lifecycle[6]),
    activePriority: String(lifecycle[7]),
    lowConfidence: Boolean(lifecycle[8]),
  };
}

const AGENT_QA_SYSTEM = `You answer as a specific DAIO reviewer agent for one request. Use the provided structured context, including current phase, status, stored review/audit artifacts, stored reasoning summaries, and recent Q&A history. Answer the user's question directly and accurately. If context is missing or the agent has not reached a phase yet, say that clearly. Do not invent private information. Never reveal private keys, VRF secrets, commit/reveal seeds, or raw hidden model reasoning. Raw hidden thinking is not available; use only final structured rationales, stored summaries, and observable state. Return ONLY valid JSON with fields: answer (string) and confidence (integer 0..10000).`;
const AGENT_SCORE_REPORT_SYSTEM = `You write a finalized DAIO request score report from the perspective of one reviewer agent. Use only the provided structured context: finalized chain status, stored document, review artifact, audit artifact, agent status/events, and public observability data. Explain why the agent gave its score. Copy expectedReportFacts exactly for request, agent, scoreGiven, and auditGiven. scoreGiven and auditGiven represent on-chain accepted participation only; if an off-chain artifact exists but the agent was not an on-chain participant, explain that caveat and do not invent accepted participation. participation must be one of reviewer_and_auditor, reviewer_only, auditor_only, skipped, observer. Never reveal private keys, VRF secrets, commit/reveal seeds, local state, or raw hidden model reasoning. Return ONLY valid JSON matching schema daio.agent.score_report.v1 with fields: schema, request, agent, scoreGiven, auditGiven, decisionSummary, rationale, evidence, caveats.`;
const REQUEST_FINAL_REPORT_SYSTEM = `You write a finalized DAIO request-level report by synthesizing all provided agent score reports. Use only the provided structured reports and finalized chain/round data. Copy expectedReportFacts exactly for request and agentReports. Explain consensus, score rationale, strengths, weaknesses, audit findings, operational notes, and caveats. consensus.agreementLevel must be one of high, moderate, low, mixed. Never reveal private keys, VRF secrets, commit/reveal seeds, local state, or raw hidden model reasoning. Return ONLY valid JSON matching schema daio.request.final_report.v1 with fields: schema, request, agentReports, consensus, finalAssessment, caveats.`;

const PROTOCOL_CONTEXT = {
  scoreScale: "0..10000",
  consensusScoring: {
    rounds: [
      "round 0: raw review median over revealed proposal scores",
      "round 1: audit-backed weighted median using contribution weights",
      "round 2: reputation-weighted final median; this is the finalized proposal score",
    ],
    contributionRule:
      "When a reviewer has at least one incoming audit, contribution is min(normalized report quality, normalized audit reliability).",
    noIncomingAuditFallback:
      "When a reviewer has zero incoming audits because peers missed audit obligations, contribution falls back to normalized audit reliability so completed audit work is still credited. A reviewer with zero incoming audits and no completed audit work still receives zero weight.",
  },
} as const;

function buildAgentQaMessages(input: {
  question: string;
  context: Record<string, unknown>;
}): ChatMessage[] {
  return buildPromptCacheMessages(
    AGENT_QA_SYSTEM,
    JSON.stringify({
      schema: "daio.agent.qa.input.v1",
      question: input.question,
      context: input.context,
    }),
  );
}

function buildAgentScoreReportMessages(input: {
  context: Record<string, unknown>;
}): ChatMessage[] {
  return buildPromptCacheMessages(
    AGENT_SCORE_REPORT_SYSTEM,
    JSON.stringify({
      schema: "daio.agent.score_report.input.v1",
      task: "Create the finalized score report for this agent and request.",
      context: input.context,
    }),
  );
}

function buildRequestFinalReportMessages(input: {
  context: Record<string, unknown>;
}): ChatMessage[] {
  return buildPromptCacheMessages(
    REQUEST_FINAL_REPORT_SYSTEM,
    JSON.stringify({
      schema: "daio.request.final_report.input.v1",
      task: "Create the final synthesized report for this finalized request.",
      context: input.context,
    }),
  );
}

function usageFromLlm(llm: { promptTokens?: number | null; completionTokens?: number | null; totalTokens?: number | null }) {
  return {
    promptTokens: llm.promptTokens ?? 0,
    completionTokens: llm.completionTokens ?? 0,
    totalTokens: llm.totalTokens ?? 0,
  };
}

function deriveParticipation(input: {
  reviewParticipant: boolean;
  auditParticipant: boolean;
}): z.infer<typeof AgentParticipation> {
  if (input.reviewParticipant && input.auditParticipant) return "reviewer_and_auditor";
  if (input.reviewParticipant) return "reviewer_only";
  if (input.auditParticipant) return "auditor_only";
  return "skipped";
}

function reportRequestFacts(input: {
  requestId: string;
  chainStatus: ReturnType<typeof serializeRequestLifecycle>;
  finalScore: number;
}) {
  return {
    requestId: input.requestId,
    chainStatus: input.chainStatus.statusName,
    finalScore: input.finalScore,
    lowConfidence: input.chainStatus.lowConfidence,
    retryCount: input.chainStatus.retryCount,
  };
}

function agentReportFacts(input: {
  agent: string;
  latestStatus: string | null;
  reviewParticipant: boolean;
  auditParticipant: boolean;
}) {
  return {
    address: getAddress(input.agent),
    latestStatus: input.latestStatus,
    participation: deriveParticipation(input),
  };
}

function scoreGivenFacts(
  reasons: ReturnType<typeof buildAgentReasons>,
  reviewParticipant: boolean,
): z.infer<typeof ScoreGiven> {
  if (!reviewParticipant || !reasons.review) return null;
  return {
    proposalScore: reasons.review.proposalScore,
    recommendation: reasons.review.recommendation,
    confidence: reasons.review.confidence,
    reportHash: reasons.review.reportHash,
  };
}

function auditGivenFacts(
  reasons: ReturnType<typeof buildAgentReasons>,
  auditParticipant: boolean,
): z.infer<typeof AuditGiven> {
  if (!auditParticipant || !reasons.audit) return null;
  return {
    auditHash: reasons.audit.auditHash,
    targetCount: reasons.audit.targetEvaluations.length,
    targetEvaluations: reasons.audit.targetEvaluations.map((evaluation) => ({
      targetReviewer: evaluation.targetReviewer,
      score: evaluation.score ?? 0,
      rationale: evaluation.rationale,
    })),
  };
}

function normalizeAgentScoreReport(
  report: AgentScoreReport,
  facts: {
    request: ReturnType<typeof reportRequestFacts>;
    agent: ReturnType<typeof agentReportFacts>;
    scoreGiven: z.infer<typeof ScoreGiven>;
    auditGiven: z.infer<typeof AuditGiven>;
  },
): AgentScoreReport {
  return AgentScoreReportModelResponse.parse({
    ...report,
    schema: "daio.agent.score_report.v1",
    request: facts.request,
    agent: facts.agent,
    scoreGiven: facts.scoreGiven,
    auditGiven: facts.auditGiven,
  });
}

function finalAgentSummary(report: AgentScoreReport) {
  return {
    agent: report.agent.address,
    participation: report.agent.participation,
    proposalScore: report.scoreGiven?.proposalScore ?? null,
    recommendation: report.scoreGiven?.recommendation ?? null,
    confidence: report.scoreGiven?.confidence ?? null,
  };
}

function normalizeRequestFinalReport(
  report: RequestFinalReport,
  facts: {
    request: ReturnType<typeof reportRequestFacts>;
    agentReports: ReturnType<typeof finalAgentSummary>[];
  },
): RequestFinalReport {
  const normalized = RequestFinalReportModelResponse.parse({
    ...report,
    schema: "daio.request.final_report.v1",
    request: facts.request,
    agentReports: facts.agentReports,
  });
  if (normalized.consensus.summary === "Consensus summary was not specified by the model.") {
    normalized.consensus.summary = normalized.finalAssessment.executiveSummary;
  }
  if (normalized.consensus.scoreSpread === "Score spread was not specified by the model.") {
    const scores = facts.agentReports
      .map((agentReport) => agentReport.proposalScore)
      .filter((score): score is number => typeof score === "number");
    normalized.consensus.scoreSpread =
      scores.length > 0
        ? `Proposal scores ranged from ${Math.min(...scores)} to ${Math.max(...scores)} across ${scores.length} scoring agents.`
        : "No proposal scores were submitted by the recorded agents.";
  }
  if (normalized.finalAssessment.executiveSummary === "Executive summary was not specified by the model.") {
    normalized.finalAssessment.executiveSummary = normalized.consensus.summary;
  }
  if (normalized.finalAssessment.scoreRationale === "Score rationale was not specified by the model.") {
    normalized.finalAssessment.scoreRationale = `${normalized.consensus.summary} ${normalized.consensus.scoreSpread}`;
  }
  return normalized;
}

export function buildServer(opts: ServerOptions): { app: FastifyInstance; db: ContentDB } {
  const db = new ContentDB(opts.dbPath);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
  installCors(app, corsConfigFromEnv());
  const deploymentPath = opts.chain?.deploymentPath ?? "./.deployments/local.json";
  const rpcUrl = opts.chain?.rpcUrl;
  const rpcUrls = opts.chain?.rpcUrls;
  const requireAgentSignatures = opts.requireAgentSignatures ?? true;
  const qaHistoryWindow = integerEnv("CONTENT_AGENT_QA_HISTORY_WINDOW", 3, 0, 50);
  let relayerProvider: Provider | undefined;
  let relayerSigner: NonceManager | undefined;

  function chainProvider(): Provider {
    const deployment = loadDeploymentSnapshot(deploymentPath);
    const urls = parseRpcUrls(rpcUrl ?? deployment.rpcUrl, rpcUrls);
    relayerProvider ??= makeRpcProvider(urls, rpcFailoverOptionsFromEnv());
    return relayerProvider;
  }

  function relayer(): NonceManager {
    const key = opts.relayer?.privateKey;
    if (!key) throw new Error("content relayer private key not configured");
    const provider = chainProvider();
    relayerSigner ??= new NonceManager(new Wallet(key, provider));
    return relayerSigner;
  }

  async function readChainStatus(requestId: string): Promise<ReturnType<typeof serializeRequestLifecycle>> {
    const deployment = loadDeploymentSnapshot(deploymentPath);
    const handles = loadContracts(deployment, chainProvider());
    const lifecycle = await withRpcReadRetries(() => handles.core.getRequestLifecycle(BigInt(requestId)));
    return serializeRequestLifecycle(requestId, lifecycle as readonly unknown[]);
  }

  async function readFinalizedRequestSnapshot(requestId: string): Promise<
    | {
        ok: true;
        chainStatus: ReturnType<typeof serializeRequestLifecycle>;
        finalScore: number;
        roundAggregates: Array<{
          round: "review" | "audit_consensus" | "reputation_final";
          score: string;
          totalWeight: string;
          confidence: string;
          coverage: string;
          lowConfidence: boolean;
          closed: boolean;
          aborted: boolean;
        }>;
        reviewParticipants: string[];
        auditParticipants: string[];
      }
    | { ok: false; chainStatus: ReturnType<typeof serializeRequestLifecycle> }
  > {
    const deployment = loadDeploymentSnapshot(deploymentPath);
    const handles = loadContracts(deployment, chainProvider());
    const lifecycle = await withRpcReadRetries(() => handles.core.getRequestLifecycle(BigInt(requestId)));
    const chainStatus = serializeRequestLifecycle(requestId, lifecycle as readonly unknown[]);
    if (chainStatus.status !== RequestStatus.Finalized) {
      return { ok: false, chainStatus };
    }

    const roundNames = ["review", "audit_consensus", "reputation_final"] as const;
    const attempt = BigInt(chainStatus.retryCount);
    const roundAggregates = [];
    for (let round = 0; round < roundNames.length; round++) {
      const aggregate = (await withRpcReadRetries(() =>
        handles.roundLedger.getRoundAggregate(BigInt(requestId), attempt, round),
      )) as readonly unknown[];
      roundAggregates.push({
        round: roundNames[round]!,
        score: String(aggregate[0]),
        totalWeight: String(aggregate[1]),
        confidence: String(aggregate[2]),
        coverage: String(aggregate[3]),
        lowConfidence: Boolean(aggregate[4]),
        closed: Boolean(aggregate[5]),
        aborted: Boolean(aggregate[6]),
      });
    }
    const reviewParticipants = ((await withRpcReadRetries(() =>
      handles.commitReveal.getReviewParticipants(BigInt(requestId), attempt),
    )) as readonly string[]).map((address) => getAddress(address));
    const auditParticipants = ((await withRpcReadRetries(() =>
      handles.commitReveal.getAuditParticipants(BigInt(requestId), attempt),
    )) as readonly string[]).map((address) => getAddress(address));
    return {
      ok: true,
      chainStatus,
      finalScore: Number(roundAggregates[2]?.score ?? roundAggregates[0]?.score ?? 0),
      roundAggregates,
      reviewParticipants,
      auditParticipants,
    };
  }

  async function buildAgentContext(input: {
    requestId: string;
    agent: string;
    sessionId?: string;
    historyLimit?: number;
    chainStatus?: ReturnType<typeof serializeRequestLifecycle> | null;
  }) {
    const agent = getAddress(input.agent);
    const agentKey = addressKey(agent);
    const doc = serializeRequestDocument(db, input.requestId);
    const agentStatus = serializeAgentStatus(db.getAgentStatus(input.requestId, agentKey));
    const reasons = buildAgentReasons(db, input.requestId, agent);
    const events = db.listAgentContextEvents(input.requestId, agentKey, 50).map((row) =>
      serializeAgentContextEvent(row),
    );
    const history =
      input.historyLimit && input.historyLimit > 0
        ? db
            .listAgentQaHistory(input.requestId, agentKey, input.sessionId ?? "default", input.historyLimit)
            .map((row) => serializeAgentQaHistory(row))
        : [];

    let chainStatus = input.chainStatus ?? null;
    let chainStatusError: string | null = null;
    if (!chainStatus) {
      try {
        chainStatus = await readChainStatus(input.requestId);
      } catch (err) {
        chainStatusError = formatError(err);
      }
    }

    const contextUsed = {
      hasDocument: Boolean(doc),
      hasReview: Boolean(reasons.review),
      hasAudit: Boolean(reasons.audit),
      agentStatus: agentStatus ? `${agentStatus.phase}:${agentStatus.status}` : null,
      historyUsed: history.length,
      eventsUsed: events.length,
      chainStatus: chainStatus?.statusName ?? null,
    };
    const context = {
      request: {
        requestId: input.requestId,
        chainStatus,
        chainStatusError,
      },
      protocol: PROTOCOL_CONTEXT,
      agent: {
        address: agent,
        latestStatus: agentStatus,
      },
      document: doc
        ? {
            updatedAt: doc.updatedAt,
            verified: doc.verified,
            proposal: {
              uri: doc.proposal.uri,
              id: doc.proposal.id,
              hash: doc.proposal.hash,
              mimeType: doc.proposal.mimeType,
              text: budgetProposal(doc.proposal.text),
            },
          }
        : null,
      reasons,
      recentEvents: events,
      recentQaHistory: history.map((row) => ({
        question: row.question,
        answer: row.answer,
        confidence: row.confidence,
        contextUsed: row.contextUsed,
        createdAt: row.createdAt,
      })),
      rawThinking: RAW_THINKING_NOTICE,
    };

    return {
      requestId: input.requestId,
      agent,
      agentKey,
      doc,
      agentStatus,
      reasons,
      events,
      history,
      chainStatus,
      chainStatusError,
      contextUsed,
      context,
    };
  }

  async function runAgentContextLlm<T extends z.ZodTypeAny>(
    messages: ChatMessage[],
    schema: T,
  ): Promise<{
    data: z.output<T>;
    llm: Awaited<ReturnType<typeof chat>>;
  }> {
    const { llm, data } = await chatJsonWithRetry(messages, {
      responseFormatJson: true,
      parse: (raw) => schema.parse(raw),
      log: (msg) => app.log.warn({ msg }, "agent context LLM retry"),
    });
    return { llm, data };
  }

  function serializeAgentScoreReport(row: NonNullable<ReturnType<ContentDB["getAgentScoreReport"]>>, cached: boolean) {
    return {
      requestId: row.requestId,
      agent: getAddress(row.agent),
      cached,
      report: AgentScoreReportModelResponse.parse(JSON.parse(row.reportJson)),
      model: row.model,
      usage: {
        promptTokens: row.promptTokens ?? 0,
        completionTokens: row.completionTokens ?? 0,
        totalTokens: row.totalTokens ?? 0,
      },
      createdAt: row.createdAt,
    };
  }

  function serializeRequestFinalReport(row: NonNullable<ReturnType<ContentDB["getRequestFinalReport"]>>, cached: boolean) {
    return {
      requestId: row.requestId,
      cached,
      agentCount: row.agentCount,
      report: RequestFinalReportModelResponse.parse(JSON.parse(row.reportJson)),
      model: row.model,
      usage: {
        promptTokens: row.promptTokens ?? 0,
        completionTokens: row.completionTokens ?? 0,
        totalTokens: row.totalTokens ?? 0,
      },
      createdAt: row.createdAt,
    };
  }

  async function getOrCreateAgentScoreReport(input: {
    requestId: string;
    agent: string;
    finalized: Extract<Awaited<ReturnType<typeof readFinalizedRequestSnapshot>>, { ok: true }>;
  }): Promise<{ row: NonNullable<ReturnType<ContentDB["getAgentScoreReport"]>>; cached: boolean }> {
    const agent = getAddress(input.agent);
    const agentKey = addressKey(agent);
    const cached = db.getAgentScoreReport(input.requestId, agentKey);
    if (cached) return { row: cached, cached: true };

    const agentContext = await buildAgentContext({
      requestId: input.requestId,
      agent,
      sessionId: "score-report",
      historyLimit: 0,
      chainStatus: input.finalized.chainStatus,
    });
    if (!agentContext.agentStatus && !agentContext.reasons.review && !agentContext.reasons.audit && agentContext.events.length === 0) {
      throw new Error("not_found");
    }

    const reviewParticipant = input.finalized.reviewParticipants.some((participant) => addressKey(participant) === agentKey);
    const auditParticipant = input.finalized.auditParticipants.some((participant) => addressKey(participant) === agentKey);
    const facts = {
      request: reportRequestFacts({
        requestId: input.requestId,
        chainStatus: input.finalized.chainStatus,
        finalScore: input.finalized.finalScore,
      }),
      agent: agentReportFacts({
        agent,
        latestStatus: agentContext.contextUsed.agentStatus,
        reviewParticipant,
        auditParticipant,
      }),
      scoreGiven: scoreGivenFacts(agentContext.reasons, reviewParticipant),
      auditGiven: auditGivenFacts(agentContext.reasons, auditParticipant),
    };
    const context = {
      ...agentContext.context,
      finalizedRequest: {
        ...facts.request,
        roundAggregates: input.finalized.roundAggregates,
        reviewParticipants: input.finalized.reviewParticipants,
        auditParticipants: input.finalized.auditParticipants,
      },
      onChainParticipation: {
        reviewParticipant,
        auditParticipant,
        acceptedReviewParticipants: input.finalized.reviewParticipants,
        acceptedAuditParticipants: input.finalized.auditParticipants,
      },
      protocol: PROTOCOL_CONTEXT,
      expectedReportFacts: facts,
    };
    const generated = await runAgentContextLlm(
      buildAgentScoreReportMessages({ context }),
      AgentScoreReportModelResponse,
    );
    const report = normalizeAgentScoreReport(generated.data, facts);
    const model = configuredModelName();
    const createdAt = Math.floor(Date.now() / 1000);
    const row = db.upsertAgentScoreReport({
      requestId: input.requestId,
      agentKey,
      agent,
      reportJson: JSON.stringify(report),
      contextSummaryJson: JSON.stringify(agentContext.contextUsed),
      model,
      promptTokens: generated.llm.promptTokens ?? null,
      completionTokens: generated.llm.completionTokens ?? null,
      totalTokens: generated.llm.totalTokens ?? null,
      createdAt,
    });
    db.appendAgentContextEvent({
      requestId: input.requestId,
      agentKey,
      agent,
      eventType: "score_report_generated",
      phase: agentContext.agentStatus?.phase ?? "Finalized",
      status: "generated",
      detail: "finalized score report generated",
      payloadJson: JSON.stringify({
        participation: report.agent.participation,
        proposalScore: report.scoreGiven?.proposalScore ?? null,
        finalScore: report.request.finalScore,
      }),
    });
    return { row, cached: false };
  }

  async function getOrCreateRequestFinalReport(input: {
    requestId: string;
    finalized: Extract<Awaited<ReturnType<typeof readFinalizedRequestSnapshot>>, { ok: true }>;
  }): Promise<{ row: NonNullable<ReturnType<ContentDB["getRequestFinalReport"]>>; cached: boolean }> {
    const cached = db.getRequestFinalReport(input.requestId);
    if (cached) return { row: cached, cached: true };

    const agentStatuses = db.listAgentStatuses(input.requestId);
    if (agentStatuses.length === 0) {
      throw new Error("not_found");
    }

    const agentReportRows = [];
    for (const status of agentStatuses) {
      const report = await getOrCreateAgentScoreReport({
        requestId: input.requestId,
        agent: status.agent,
        finalized: input.finalized,
      });
      agentReportRows.push(report.row);
    }
    const agentReports = agentReportRows.map((row) => AgentScoreReportModelResponse.parse(JSON.parse(row.reportJson)));
    const requestFacts = reportRequestFacts({
      requestId: input.requestId,
      chainStatus: input.finalized.chainStatus,
      finalScore: input.finalized.finalScore,
    });
    const agentReportFactsList = agentReports.map((report) => finalAgentSummary(report));
    const doc = serializeRequestDocument(db, input.requestId);
    const generated = await runAgentContextLlm(
      buildRequestFinalReportMessages({
        context: {
          request: {
            ...requestFacts,
            chainStatus: input.finalized.chainStatus,
            roundAggregates: input.finalized.roundAggregates,
            reviewParticipants: input.finalized.reviewParticipants,
            auditParticipants: input.finalized.auditParticipants,
          },
          protocol: PROTOCOL_CONTEXT,
          document: doc
            ? {
                verified: doc.verified,
                proposal: {
                  uri: doc.proposal.uri,
                  id: doc.proposal.id,
                  hash: doc.proposal.hash,
                  mimeType: doc.proposal.mimeType,
                },
              }
            : null,
          agentReports,
          expectedReportFacts: {
            request: requestFacts,
            agentReports: agentReportFactsList,
          },
          rawThinking: RAW_THINKING_NOTICE,
        },
      }),
      RequestFinalReportModelResponse,
    );
    const report = normalizeRequestFinalReport(generated.data, {
      request: requestFacts,
      agentReports: agentReportFactsList,
    });
    const model = configuredModelName();
    const createdAt = Math.floor(Date.now() / 1000);
    const row = db.upsertRequestFinalReport({
      requestId: input.requestId,
      reportJson: JSON.stringify(report),
      agentCount: agentStatuses.length,
      model,
      promptTokens: generated.llm.promptTokens ?? null,
      completionTokens: generated.llm.completionTokens ?? null,
      totalTokens: generated.llm.totalTokens ?? null,
      createdAt,
    });
    for (const status of agentStatuses) {
      db.appendAgentContextEvent({
        requestId: input.requestId,
        agentKey: status.agentKey,
        agent: status.agent,
        eventType: "final_report_generated",
        phase: "Finalized",
        status: "generated",
        detail: "request final report generated",
        payloadJson: JSON.stringify({
          agentCount: agentStatuses.length,
          finalScore: report.request.finalScore,
        }),
      });
    }
    return { row, cached: false };
  }

  async function buildUSDAIORequestIntent(body: z.infer<typeof RequestIntentBody>) {
    const normalized = normalizeRequestIntentFields({
      ...body,
      deadline: body.deadline ?? String(Math.floor(Date.now() / 1000) + 3600),
    });
    if (!normalized.ok) return normalized;

    const deployment = loadDeploymentSnapshot(deploymentPath);
    const provider = chainProvider();
    const handles = loadContracts(deployment, provider);
    const nonce = (await handles.paymentRouter.nonces(normalized.requester)) as bigint;
    const network = await provider.getNetwork();
    const domain = {
      name: "DAIOPaymentRouter",
      version: "1",
      chainId: Number(network.chainId),
      verifyingContract: getAddress(deployment.contracts.paymentRouter),
    };
    const message = {
      requester: normalized.requester,
      proposalURIHash: normalized.proposalURIHash,
      proposalHash: normalized.proposalHash,
      rubricHash: normalized.rubricHash,
      domainMask: normalized.domainMask,
      tier: normalized.tier,
      priorityFee: normalized.priorityFee,
      nonce: nonce.toString(),
      deadline: normalized.deadline!,
    };
    return {
      ok: true as const,
      requester: normalized.requester,
      id: normalized.id,
      proposalURI: normalized.proposalURI,
      proposalURIHash: normalized.proposalURIHash,
      proposalHash: normalized.proposalHash,
      rubricHash: normalized.rubricHash,
      domainMask: normalized.domainMask,
      tier: normalized.tier,
      tierName: Tier[normalized.tier] ?? `Tier${normalized.tier}`,
      priorityFee: normalized.priorityFee,
      nonce: nonce.toString(),
      deadline: normalized.deadline!,
      typedData: {
        domain,
        primaryType: "RequestIntent",
        types: REQUEST_INTENT_TYPES,
        message,
      },
    };
  }

  async function relayUSDAIORequest(body: z.infer<typeof RelayedDocumentBody>) {
    const intent = await buildUSDAIORequestIntent(body);
    if (!intent.ok) return intent;

    const deployment = loadDeploymentSnapshot(deploymentPath);
    const signer = relayer();
    const signerAddress = getAddress(await signer.getAddress());
    const handles = loadContracts(deployment, signer);
    const args = [
      intent.requester,
      intent.proposalURI,
      intent.proposalHash,
      intent.rubricHash,
      intent.domainMask,
      intent.tier,
      intent.priorityFee,
      intent.deadline,
      body.signature,
    ] as const;
    try {
      await withRpcReadRetries(() =>
        handles.paymentRouter.createRequestWithUSDAIOBySig.staticCall(...args),
      );
    } catch (err) {
      throw new Error(`relayed request preflight failed: ${formatError(err)}`);
    }
    const send = async () =>
      handles.paymentRouter.createRequestWithUSDAIOBySig(...args);
    let tx;
    try {
      tx = await send();
    } catch (err) {
      if (!isNonceError(err)) throw err;
      signer.reset();
      tx = await send();
    }
    const receipt = await waitForTransactionWithRetries(tx, opts.relayer?.confirmations ?? txFinalityConfirmationsFromEnv());
    if (!receipt || receipt.status !== 1) throw new Error(`relayed request transaction failed: ${tx.hash}`);

    const iface = new Interface(Artifacts.PaymentRouter().abi as never[]);
    const paymentRouterAddress = getAddress(deployment.contracts.paymentRouter);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paidEvents: any[] = receipt.logs.flatMap((log: { address: string; topics: readonly string[]; data: string }) => {
      if (getAddress(log.address) !== paymentRouterAddress) return [];
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        return parsed?.name === "RequestPaid" ? [parsed] : [];
      } catch (_err) {
        return [];
      }
    });
    const paid = paidEvents.find((event) => getAddress(String(event.args.requester)) === intent.requester);
    if (!paid) throw new Error("relayed request paid event not found");
    return {
      ok: true as const,
      relayer: signerAddress,
      txHash: receipt.hash,
      requestId: String(paid.args.requestId),
      blockNumber: receipt.blockNumber,
      intent,
    };
  }

  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { requestId: string } }>("/requests/:requestId/chain-status", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId)) {
      reply.code(400);
      return { error: "invalid_request_id" };
    }
    try {
      const deployment = loadDeploymentSnapshot(deploymentPath);
      const handles = loadContracts(deployment, chainProvider());
      const lifecycle = await withRpcReadRetries(() =>
        handles.core.getRequestLifecycle(BigInt(req.params.requestId)),
      );
      return serializeRequestLifecycle(req.params.requestId, lifecycle as readonly unknown[]);
    } catch (err) {
      reply.code(503);
      return { error: "chain_status_unavailable", detail: formatError(err) };
    }
  });

  app.post("/request-intents/usdaio", async (req, reply) => {
    const parsed = RequestIntentBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_request_intent", issues: parsed.error.issues };
    }
    try {
      const intent = await buildUSDAIORequestIntent(parsed.data);
      if (!intent.ok) {
        reply.code(400);
        return intent;
      }
      return intent;
    } catch (err) {
      reply.code(503);
      return { error: "chain_intent_unavailable", detail: formatError(err) };
    }
  });

  app.post("/requests/relayed-document", async (req, reply) => {
    const parsed = RelayedDocumentBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_relayed_document", issues: parsed.error.issues };
    }
    const body = parsed.data;
    const normalized = normalizeRequestIntentFields(body);
    if (!normalized.ok) {
      reply.code(400);
      return normalized;
    }

    let relayed: Awaited<ReturnType<typeof relayUSDAIORequest>>;
    try {
      relayed = await relayUSDAIORequest(body);
    } catch (err) {
      reply.code(502);
      return { error: "relayed_request_failed", detail: formatError(err) };
    }
    if (!relayed.ok) {
      reply.code(400);
      return relayed;
    }

    let verified: Awaited<ReturnType<typeof verifyRequestTransaction>>;
    try {
      verified = await verifyRequestTransaction({
        requestId: relayed.requestId,
        txHash: relayed.txHash,
        requester: normalized.requester,
        textHash: normalized.proposalHash,
        deploymentPath,
        rpcUrl,
        rpcUrls,
      });
    } catch (err) {
      reply.code(503);
      return { error: "chain_verification_unavailable", detail: formatError(err) };
    }
    if (!verified.ok) {
      reply.code(verified.code);
      return verified;
    }

    const idFromUri = proposalIdFromUri(verified.proposalURI);
    if (!idFromUri) {
      reply.code(400);
      return { error: "unsupported_proposal_uri", proposalURI: verified.proposalURI };
    }
    const mimeType = body.mimeType ?? "text/markdown";
    db.upsertProposal({ id: idFromUri, hash: normalized.proposalHash, mimeType, text: body.text });
    db.upsertRequestDocument({
      requestId: verified.requestId,
      requester: verified.requester,
      proposalUri: verified.proposalURI,
      proposalHash: verified.proposalHash,
      rubricHash: verified.rubricHash,
      domainMask: verified.domainMask,
      tier: verified.tier,
      priorityFee: verified.priorityFee,
      paymentTxHash: verified.txHash,
      paymentFunction: verified.paymentFunction,
      paymentToken: verified.paymentToken,
      amountPaid: verified.amountPaid,
      blockNumber: verified.blockNumber,
      status: verified.status,
      statusName: verified.statusName,
      proposalId: idFromUri,
    });
    return {
      relayed: {
        relayer: relayed.relayer,
        requestId: relayed.requestId,
        txHash: relayed.txHash,
        blockNumber: relayed.blockNumber,
      },
      document: serializeRequestDocument(db, relayed.requestId)!,
    };
  });

  app.post("/proposals", async (req, reply) => {
    const body = req.body as { id?: string; text?: string; mimeType?: string };
    if (!body.id || !body.text) {
      reply.code(400);
      return { error: "id and text required" };
    }
    const mimeType = body.mimeType ?? "text/markdown";
    const hash = keccak256(toUtf8Bytes(body.text));
    db.upsertProposal({ id: body.id, hash, mimeType, text: body.text });
    return {
      uri: `content://proposals/${body.id}`,
      id: body.id,
      hash,
      mimeType,
      text: body.text,
    };
  });

  app.get<{ Params: { id: string } }>("/proposals/:id", async (req, reply) => {
    const row = db.getProposal(req.params.id);
    if (!row) {
      reply.code(404);
      return { error: "not_found" };
    }
    return {
      uri: `content://proposals/${row.id}`,
      id: row.id,
      hash: row.hash,
      mimeType: row.mimeType,
      text: row.text,
    };
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/proposals/:id/markdown", async (req, reply) => {
    const row = db.getProposal(req.params.id);
    if (!row) {
      reply.code(404);
      return { error: "not_found" };
    }
    const proposal = {
      uri: `content://proposals/${row.id}`,
      id: row.id,
      hash: row.hash,
      mimeType: row.mimeType,
      text: row.text,
    };
    if (wantsRawMarkdown(req)) return sendRawMarkdown(reply, proposal);
    return markdownResponse(proposal);
  });

  app.post("/reports", async (req, reply) => {
    const parsed = ReviewArtifactBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_artifact", issues: parsed.error.issues };
    }
    const artifact = "artifact" in parsed.data ? parsed.data.artifact : parsed.data;
    const signature = "signature" in parsed.data ? parsed.data.signature : undefined;
    const json = canonicalJson(artifact);
    const hash = canonicalHash(artifact);
    const sig = requireValidAgentSignature({
      enabled: requireAgentSignatures,
      signer: artifact.reviewer,
      message: agentArtifactMessage("review", hash),
      signature,
    });
    if (!sig.ok) {
      reply.code(sig.code);
      return { error: sig.error };
    }
    db.upsertBlob("reports", { hash, json });
    db.indexReviewArtifact({
      requestId: artifact.requestId,
      reviewerKey: addressKey(artifact.reviewer),
      reviewer: getAddress(artifact.reviewer),
      hash,
    });
    db.appendAgentContextEvent({
      requestId: artifact.requestId,
      agentKey: addressKey(artifact.reviewer),
      agent: getAddress(artifact.reviewer),
      eventType: "review_artifact",
      phase: "ReviewCommit",
      status: "artifact_stored",
      detail: "review artifact stored",
      payloadJson: JSON.stringify({
        reportHash: hash,
        proposalScore: artifact.proposalScore,
        recommendation: artifact.report.recommendation,
        confidence: artifact.report.confidence,
        summary: artifact.report.summary,
      }),
    });
    return { uri: `content://reports/${hash}`, hash, artifact };
  });

  app.get<{ Params: { hash: string } }>("/reports/:hash", async (req, reply) => {
    const row = db.getBlob("reports", req.params.hash);
    if (!row) {
      reply.code(404);
      return { error: "not_found" };
    }
    return { uri: `content://reports/${row.hash}`, hash: row.hash, artifact: JSON.parse(row.json) };
  });

  app.post("/audits", async (req, reply) => {
    const parsed = AuditArtifactBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_artifact", issues: parsed.error.issues };
    }
    const artifact = "artifact" in parsed.data ? parsed.data.artifact : parsed.data;
    const signature = "signature" in parsed.data ? parsed.data.signature : undefined;
    const json = canonicalJson(artifact);
    const hash = canonicalHash(artifact);
    const sig = requireValidAgentSignature({
      enabled: requireAgentSignatures,
      signer: artifact.auditor,
      message: agentArtifactMessage("audit", hash),
      signature,
    });
    if (!sig.ok) {
      reply.code(sig.code);
      return { error: sig.error };
    }
    db.upsertBlob("audits", { hash, json });
    db.indexAuditArtifact({
      requestId: artifact.requestId,
      auditorKey: addressKey(artifact.auditor),
      auditor: getAddress(artifact.auditor),
      hash,
    });
    db.appendAgentContextEvent({
      requestId: artifact.requestId,
      agentKey: addressKey(artifact.auditor),
      agent: getAddress(artifact.auditor),
      eventType: "audit_artifact",
      phase: "AuditCommit",
      status: "artifact_stored",
      detail: "audit artifact stored",
      payloadJson: JSON.stringify({
        auditHash: hash,
        targetCount: artifact.targets.length,
        targets: artifact.targets,
        scores: artifact.scores,
      }),
    });
    return { uri: `content://audits/${hash}`, hash, artifact };
  });

  app.get<{ Params: { hash: string } }>("/audits/:hash", async (req, reply) => {
    const row = db.getBlob("audits", req.params.hash);
    if (!row) {
      reply.code(404);
      return { error: "not_found" };
    }
    return { uri: `content://audits/${row.hash}`, hash: row.hash, artifact: JSON.parse(row.json) };
  });

  app.post("/requests/document-from-tx", async (req, reply) => {
    const parsed = SubmitDocumentBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_document_submission", issues: parsed.error.issues };
    }

    const body = parsed.data;
    const hash = keccak256(toUtf8Bytes(body.text));
    let ids: Awaited<ReturnType<typeof findRequestIdsFromPaymentTx>>;
    try {
      ids = await findRequestIdsFromPaymentTx({
        txHash: body.txHash,
        requester: body.requester,
        deploymentPath,
        rpcUrl,
        rpcUrls,
      });
    } catch (err) {
      reply.code(503);
      return { error: "payment_tx_lookup_unavailable", detail: (err as Error).message };
    }
    if (!ids.ok) {
      reply.code(ids.code);
      return ids;
    }
    if (ids.requestIds.length !== 1) {
      reply.code(400);
      return { error: "ambiguous_request_id", requestIds: ids.requestIds };
    }

    let verified: Awaited<ReturnType<typeof verifyRequestTransaction>>;
    try {
      verified = await verifyRequestTransaction({
        requestId: ids.requestIds[0]!,
        txHash: body.txHash,
        requester: body.requester,
        textHash: hash,
        deploymentPath,
        rpcUrl,
        rpcUrls,
      });
    } catch (err) {
      reply.code(503);
      return { error: "chain_verification_unavailable", detail: (err as Error).message };
    }
    if (!verified.ok) {
      reply.code(verified.code);
      return verified;
    }

    const idFromUri = proposalIdFromUri(verified.proposalURI);
    if (!idFromUri) {
      reply.code(400);
      return { error: "unsupported_proposal_uri", proposalURI: verified.proposalURI };
    }
    if (body.id && body.id !== idFromUri) {
      reply.code(400);
      return { error: "proposal_id_mismatch", expected: idFromUri, got: body.id };
    }

    const mimeType = body.mimeType ?? "text/markdown";
    db.upsertProposal({ id: idFromUri, hash, mimeType, text: body.text });
    db.upsertRequestDocument({
      requestId: verified.requestId,
      requester: verified.requester,
      proposalUri: verified.proposalURI,
      proposalHash: verified.proposalHash,
      rubricHash: verified.rubricHash,
      domainMask: verified.domainMask,
      tier: verified.tier,
      priorityFee: verified.priorityFee,
      paymentTxHash: verified.txHash,
      paymentFunction: verified.paymentFunction,
      paymentToken: verified.paymentToken,
      amountPaid: verified.amountPaid,
      blockNumber: verified.blockNumber,
      status: verified.status,
      statusName: verified.statusName,
      proposalId: idFromUri,
    });
    return serializeRequestDocument(db, verified.requestId)!;
  });

  app.post<{ Params: { requestId: string } }>("/requests/:requestId/document", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId)) {
      reply.code(400);
      return { error: "invalid_request_id" };
    }
    const parsed = SubmitDocumentBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_document_submission", issues: parsed.error.issues };
    }

    const body = parsed.data;
    const hash = keccak256(toUtf8Bytes(body.text));
    let verified: Awaited<ReturnType<typeof verifyRequestTransaction>>;
    try {
      verified = await verifyRequestTransaction({
        requestId: req.params.requestId,
        txHash: body.txHash,
        requester: body.requester,
        textHash: hash,
        deploymentPath,
        rpcUrl,
        rpcUrls,
      });
    } catch (err) {
      reply.code(503);
      return { error: "chain_verification_unavailable", detail: (err as Error).message };
    }
    if (!verified.ok) {
      reply.code(verified.code);
      return verified;
    }

    const idFromUri = proposalIdFromUri(verified.proposalURI);
    if (!idFromUri) {
      reply.code(400);
      return { error: "unsupported_proposal_uri", proposalURI: verified.proposalURI };
    }
    if (body.id && body.id !== idFromUri) {
      reply.code(400);
      return { error: "proposal_id_mismatch", expected: idFromUri, got: body.id };
    }

    const mimeType = body.mimeType ?? "text/markdown";
    db.upsertProposal({ id: idFromUri, hash, mimeType, text: body.text });
    db.upsertRequestDocument({
      requestId: verified.requestId,
      requester: verified.requester,
      proposalUri: verified.proposalURI,
      proposalHash: verified.proposalHash,
      rubricHash: verified.rubricHash,
      domainMask: verified.domainMask,
      tier: verified.tier,
      priorityFee: verified.priorityFee,
      paymentTxHash: verified.txHash,
      paymentFunction: verified.paymentFunction,
      paymentToken: verified.paymentToken,
      amountPaid: verified.amountPaid,
      blockNumber: verified.blockNumber,
      status: verified.status,
      statusName: verified.statusName,
      proposalId: idFromUri,
    });
    return serializeRequestDocument(db, req.params.requestId)!;
  });

  app.get<{ Params: { requestId: string } }>("/requests/:requestId/document", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId)) {
      reply.code(400);
      return { error: "invalid_request_id" };
    }
    const doc = serializeRequestDocument(db, req.params.requestId);
    if (!doc) {
      reply.code(404);
      return { error: "not_found" };
    }
    return doc;
  });

  app.get<{ Params: { requestId: string }; Querystring: { format?: string } }>(
    "/requests/:requestId/markdown",
    async (req, reply) => {
      if (!/^\d+$/.test(req.params.requestId)) {
        reply.code(400);
        return { error: "invalid_request_id" };
      }
      const doc = serializeRequestDocument(db, req.params.requestId);
      if (!doc) {
        reply.code(404);
        return { error: "not_found" };
      }
      const proposal = {
        uri: doc.proposal.uri,
        id: doc.proposal.id,
        hash: doc.proposal.hash,
        mimeType: doc.proposal.mimeType,
        text: doc.proposal.text,
      };
      if (wantsRawMarkdown(req)) return sendRawMarkdown(reply, proposal);
      return {
        requestId: doc.verified.requestId,
        updatedAt: doc.updatedAt,
        verified: doc.verified,
        proposal: markdownResponse(proposal),
      };
    },
  );

  app.put("/agent-status", async (req, reply) => {
    const parsed = AgentStatusBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_agent_status", issues: parsed.error.issues };
    }
    const body = parsed.data;
    const agent = getAddress(body.agent);
    const sig = requireValidAgentSignature({
      enabled: requireAgentSignatures,
      signer: agent,
      message: agentStatusMessage({
        requestId: body.requestId,
        agent,
        phase: body.phase,
        status: body.status,
        detail: body.detail,
        payload: body.payload,
      }),
      signature: body.signature,
    });
    if (!sig.ok) {
      reply.code(sig.code);
      return { error: sig.error };
    }
    db.upsertAgentStatus({
      requestId: body.requestId,
      agentKey: addressKey(agent),
      agent,
      phase: body.phase,
      status: body.status,
      detail: body.detail,
      payloadJson: JSON.stringify(body.payload),
    });
    return serializeAgentStatus(db.getAgentStatus(body.requestId, addressKey(agent)));
  });

  app.get<{ Params: { requestId: string; agent: string } }>("/requests/:requestId/agents/:agent/status", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId) || !HexAddress.safeParse(req.params.agent).success) {
      reply.code(400);
      return { error: "invalid_params" };
    }
    const row = db.getAgentStatus(req.params.requestId, addressKey(req.params.agent));
    if (!row) {
      reply.code(404);
      return { error: "not_found" };
    }
    return serializeAgentStatus(row);
  });

  app.get<{ Params: { requestId: string } }>("/requests/:requestId/agent-statuses", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId)) {
      reply.code(400);
      return { error: "invalid_request_id" };
    }
    return {
      requestId: req.params.requestId,
      agents: db.listAgentStatuses(req.params.requestId).map((row) => serializeAgentStatus(row)),
    };
  });

  app.post<{ Params: { requestId: string; agent: string } }>("/requests/:requestId/agents/:agent/ask", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId) || !HexAddress.safeParse(req.params.agent).success) {
      reply.code(400);
      return { error: "invalid_params" };
    }
    const parsed = AgentAskBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_agent_question", issues: parsed.error.issues };
    }

    const agentContext = await buildAgentContext({
      requestId: req.params.requestId,
      agent: req.params.agent,
      sessionId: parsed.data.sessionId,
      historyLimit: qaHistoryWindow,
    });

    if (
      !agentContext.doc &&
      !agentContext.agentStatus &&
      !agentContext.reasons.review &&
      !agentContext.reasons.audit &&
      agentContext.events.length === 0 &&
      !agentContext.chainStatus
    ) {
      reply.code(404);
      return { error: "not_found" };
    }

    let generated;
    try {
      generated = await runAgentContextLlm(
        buildAgentQaMessages({ question: parsed.data.question, context: agentContext.context }),
        AgentQaModelResponse,
      );
    } catch (err) {
      reply.code(503);
      return { error: "agent_qa_unavailable", detail: formatError(err) };
    }

    const model = configuredModelName();
    const createdAt = Math.floor(Date.now() / 1000);
    const stored = db.insertAgentQaHistory({
      requestId: req.params.requestId,
      agentKey: agentContext.agentKey,
      agent: agentContext.agent,
      sessionId: parsed.data.sessionId,
      question: parsed.data.question,
      answer: generated.data.answer,
      confidence: generated.data.confidence,
      contextSummaryJson: JSON.stringify(agentContext.contextUsed),
      model,
      promptTokens: generated.llm.promptTokens ?? null,
      completionTokens: generated.llm.completionTokens ?? null,
      totalTokens: generated.llm.totalTokens ?? null,
      createdAt,
    });
    db.appendAgentContextEvent({
      requestId: req.params.requestId,
      agentKey: agentContext.agentKey,
      agent: agentContext.agent,
      eventType: "qa_answer",
      phase: agentContext.agentStatus?.phase ?? null,
      status: "answered",
      detail: parsed.data.question.slice(0, 200),
      payloadJson: JSON.stringify({
        sessionId: parsed.data.sessionId,
        qaHistoryId: stored.id,
        confidence: generated.data.confidence,
        historyUsed: agentContext.history.length,
      }),
    });

    return {
      requestId: req.params.requestId,
      agent: agentContext.agent,
      sessionId: parsed.data.sessionId,
      answer: generated.data.answer,
      confidence: generated.data.confidence,
      contextUsed: agentContext.contextUsed,
      model,
      usage: usageFromLlm(generated.llm),
      createdAt: stored.createdAt,
    };
  });

  app.post<{ Params: { requestId: string; agent: string } }>(
    "/requests/:requestId/agents/:agent/score-report",
    async (req, reply) => {
      if (!/^\d+$/.test(req.params.requestId) || !HexAddress.safeParse(req.params.agent).success) {
        reply.code(400);
        return { error: "invalid_params" };
      }

      let finalized: Awaited<ReturnType<typeof readFinalizedRequestSnapshot>>;
      try {
        finalized = await readFinalizedRequestSnapshot(req.params.requestId);
      } catch (err) {
        reply.code(503);
        return { error: "chain_status_unavailable", detail: formatError(err) };
      }
      if (!finalized.ok) {
        reply.code(409);
        return { error: "request_not_finalized", chainStatus: finalized.chainStatus };
      }

      try {
        const result = await getOrCreateAgentScoreReport({
          requestId: req.params.requestId,
          agent: req.params.agent,
          finalized,
        });
        return serializeAgentScoreReport(result.row, result.cached);
      } catch (err) {
        if (formatError(err) === "not_found") {
          reply.code(404);
          return { error: "not_found" };
        }
        reply.code(503);
        return { error: "score_report_unavailable", detail: formatError(err) };
      }
    },
  );

  app.post<{ Params: { requestId: string } }>("/requests/:requestId/final-report", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId)) {
      reply.code(400);
      return { error: "invalid_params" };
    }

    let finalized: Awaited<ReturnType<typeof readFinalizedRequestSnapshot>>;
    try {
      finalized = await readFinalizedRequestSnapshot(req.params.requestId);
    } catch (err) {
      reply.code(503);
      return { error: "chain_status_unavailable", detail: formatError(err) };
    }
    if (!finalized.ok) {
      reply.code(409);
      return { error: "request_not_finalized", chainStatus: finalized.chainStatus };
    }

    try {
      const result = await getOrCreateRequestFinalReport({ requestId: req.params.requestId, finalized });
      return serializeRequestFinalReport(result.row, result.cached);
    } catch (err) {
      if (formatError(err) === "not_found") {
        reply.code(404);
        return { error: "not_found" };
      }
      reply.code(503);
      return { error: "final_report_unavailable", detail: formatError(err) };
    }
  });

  app.get<{ Params: { requestId: string; agent: string }; Querystring: { sessionId?: string; limit?: string | number } }>(
    "/requests/:requestId/agents/:agent/qa-history",
    async (req, reply) => {
      if (!/^\d+$/.test(req.params.requestId) || !HexAddress.safeParse(req.params.agent).success) {
        reply.code(400);
        return { error: "invalid_params" };
      }
      const parsed = AgentQaHistoryQuery.safeParse(req.query ?? {});
      if (!parsed.success) {
        reply.code(400);
        return { error: "invalid_qa_history_query", issues: parsed.error.issues };
      }
      const agent = getAddress(req.params.agent);
      const history = db
        .listAgentQaHistory(req.params.requestId, addressKey(agent), parsed.data.sessionId, parsed.data.limit)
        .map((row) => serializeAgentQaHistory(row));
      return {
        requestId: req.params.requestId,
        agent,
        sessionId: parsed.data.sessionId,
        history,
      };
    },
  );

  app.get<{ Params: { requestId: string; agent: string } }>("/requests/:requestId/agents/:agent/reasons", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId) || !HexAddress.safeParse(req.params.agent).success) {
      reply.code(400);
      return { error: "invalid_params" };
    }
    return buildAgentReasons(db, req.params.requestId, req.params.agent);
  });

  return { app, db };
}
