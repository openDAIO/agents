import { budgetProposal, budgetTargetReport } from "./prepareInput.js";
import { buildPromptCacheMessages, type ChatMessage } from "./client.js";

export interface ReviewEnvelope {
  schema: "daio.llm.input.v1";
  task: "review";
  chain: { chainId: number; core: string; commitRevealManager: string };
  request: {
    requestId: string;
    proposalURI: string;
    proposalHash: string;
    rubricHash: string;
    domainMask: string;
    tier: string;
    status: string;
  };
  reviewer: { wallet: string; ensName: string; agentId: string; domainMask: string };
  content: {
    proposal: { uri: string; mimeType: string; text: string };
    rubric: { hash: string; text: string };
  };
  constraints: { scoreScale: number; outputLanguage: string; maxReportBytes: number };
}

export interface AuditEnvelope {
  schema: "daio.llm.input.v1";
  task: "audit";
  chain: { chainId: number; core: string; commitRevealManager: string };
  request: {
    requestId: string;
    proposalURI: string;
    proposalHash: string;
    rubricHash: string;
    domainMask: string;
    tier: string;
    status: string;
  };
  auditor: { wallet: string; ensName: string; agentId: string };
  content: {
    proposal: { uri: string; mimeType: string; text: string };
    rubric: { hash: string; text: string };
    targets: Array<{
      targetReviewer: string;
      proposalScore: number;
      reportURI: string;
      reportHash: string;
      report: unknown;
    }>;
  };
  constraints: { scoreScale: number; targetOrder: "must_preserve_input_order" };
}

const SYSTEM_BASE = `You are a DAIO AI reviewer. You evaluate scholarly papers, DAO proposals, legal drafts, and policy documents. Output ONLY valid JSON matching the requested schema. Do not include any prose outside the JSON object. Score scale is 0..10000 (uint16, 10000 = best). Be terse, neutral, and grounded in the artifact text.`;

const PROMPT_CACHE_LAYOUT = `Prompt-cache layout: this system message intentionally carries the long shared artifact context before per-agent variables. Treat the JSON block below as "shared". The user message supplies "input". Both are authoritative.`;

const PERSONA_GUARD = `If input.persona is present, it shapes WHICH dimensions you weight and HOW strict you are, not the output format. The schema, field names, address echoes, score scale (0..10000), and target ordering are absolute and must not change. Do not mention the persona in the output.`;

function readEnvPersona(taskKey: "review" | "audit"): string | undefined {
  const taskSpecificKey = taskKey === "review" ? "AGENT_REVIEW_STYLE" : "AGENT_AUDIT_STYLE";
  const taskSpecific = process.env[taskSpecificKey]?.trim();
  const general = process.env.AGENT_PERSONA?.trim();
  const parts = [general, taskSpecific].filter((s): s is string => Boolean(s && s.length));
  return parts.length ? parts.join("\n") : undefined;
}

function buildSharedContext(envelope: ReviewEnvelope | AuditEnvelope): Record<string, unknown> {
  return {
    schema: "daio.llm.shared_context.v1",
    content: {
      proposal: {
        // Put the long common text before request-specific ids so provider-side
        // prefix caches can reuse the expensive artifact tokens across agents.
        text: budgetProposal(envelope.content.proposal.text),
        mimeType: envelope.content.proposal.mimeType,
      },
      rubric: {
        text: envelope.content.rubric.text,
        hash: envelope.content.rubric.hash,
      },
    },
    request: {
      requestId: envelope.request.requestId,
      proposalURI: envelope.request.proposalURI,
      proposalHash: envelope.request.proposalHash,
      rubricHash: envelope.request.rubricHash,
      domainMask: envelope.request.domainMask,
      tier: envelope.request.tier,
    },
    chain: envelope.chain,
    constraints: envelope.constraints,
  };
}

function buildSystemPrompt(taskInstruction: string, sharedContext: Record<string, unknown>): string {
  const sections = [
    SYSTEM_BASE,
    PROMPT_CACHE_LAYOUT,
    JSON.stringify(sharedContext),
    PERSONA_GUARD,
  ];
  sections.push(taskInstruction);
  return sections.join("\n\n");
}

const REVIEW_INSTRUCTION = `For task=review, you must output an object that conforms to schema "daio.review.output.v1". Fields:
- schema: "daio.review.output.v1"
- requestId: string of digits, must equal shared.request.requestId
- reviewer: 0x-prefixed address, must equal input.reviewer.wallet
- proposalScore: integer 0..10000 reflecting your overall judgement of the artifact
- report.summary: 1–4 sentence neutral summary
- report.rubricAssessments: array of {criterion (snake_case_string), score (0..10000), rationale (≤2 sentences)}, 3–6 entries covering distinct dimensions
- report.strengths: 1–4 short bullets
- report.weaknesses: 1–4 short bullets
- report.risks: 0–3 short bullets (optional)
- report.recommendation: one of "accept" | "weak_accept" | "borderline" | "weak_reject" | "reject"
- report.confidence: integer 0..10000 reflecting your self-confidence
Return ONLY the JSON object. Do not include markdown fences.`;

const AUDIT_INSTRUCTION = `For task=audit, you must output an object that conforms to schema "daio.audit.output.v1". Fields:
- schema: "daio.audit.output.v1"
- requestId: string of digits, must equal shared.request.requestId
- auditor: 0x-prefixed address, must equal input.auditor.wallet
- targetEvaluations: array of objects, ONE PER TARGET in input.targets, IN THE EXACT ORDER GIVEN. Each entry:
  - targetReviewer: 0x-prefixed address, copy from input
  - score: integer 0..10000, your evaluation of how well that reviewer's report covers the artifact (NOT agreement with their proposalScore)
  - rationale: 1–2 sentences
  - confidence: integer 0..10000 (optional)
Return ONLY the JSON object. Do not include markdown fences.`;

export function buildReviewMessages(envelope: ReviewEnvelope): ChatMessage[] {
  const input = {
    schema: "daio.llm.review_input.v1",
    task: "review",
    request: {
      status: envelope.request.status,
    },
    reviewer: envelope.reviewer,
    persona: readEnvPersona("review") ?? null,
  };
  return buildPromptCacheMessages(buildSystemPrompt(REVIEW_INSTRUCTION, buildSharedContext(envelope)), JSON.stringify(input));
}

export function buildAuditMessages(envelope: AuditEnvelope): ChatMessage[] {
  const input = {
    schema: "daio.llm.audit_input.v1",
    task: "audit",
    request: {
      status: envelope.request.status,
    },
    auditor: envelope.auditor,
    persona: readEnvPersona("audit") ?? null,
    targets: envelope.content.targets.map((t) => ({
      ...t,
      report: budgetTargetReport(t.report),
    })),
  };
  return buildPromptCacheMessages(buildSystemPrompt(AUDIT_INSTRUCTION, buildSharedContext(envelope)), JSON.stringify(input));
}
