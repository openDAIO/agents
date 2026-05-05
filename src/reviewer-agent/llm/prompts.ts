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

const PERSONA_GUARD = `Your persona shapes WHICH dimensions you weight and HOW strict you are, not the output format. The schema, field names, address echoes, score scale (0..10000), and target ordering are absolute and must not change. Do not mention your persona in the output.`;

function readEnvPersona(taskKey: "review" | "audit"): string | undefined {
  const taskSpecificKey = taskKey === "review" ? "AGENT_REVIEW_STYLE" : "AGENT_AUDIT_STYLE";
  const taskSpecific = process.env[taskSpecificKey]?.trim();
  const general = process.env.AGENT_PERSONA?.trim();
  const parts = [general, taskSpecific].filter((s): s is string => Boolean(s && s.length));
  return parts.length ? parts.join("\n") : undefined;
}

function buildSystemPrompt(taskInstruction: string, taskKey: "review" | "audit"): string {
  const persona = readEnvPersona(taskKey);
  const sections = [SYSTEM_BASE];
  if (persona) sections.push(`Persona (independent reviewer character):\n${persona}\n\n${PERSONA_GUARD}`);
  sections.push(taskInstruction);
  return sections.join("\n\n");
}

const REVIEW_INSTRUCTION = `For task=review, you must output an object that conforms to schema "daio.review.output.v1". Fields:
- schema: "daio.review.output.v1"
- requestId: string of digits, must equal input.request.requestId
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
- requestId: string of digits, must equal input.request.requestId
- auditor: 0x-prefixed address, must equal input.auditor.wallet
- targetEvaluations: array of objects, ONE PER TARGET in input.content.targets, IN THE EXACT ORDER GIVEN. Each entry:
  - targetReviewer: 0x-prefixed address, copy from input
  - score: integer 0..10000, your evaluation of how well that reviewer's report covers the artifact (NOT agreement with their proposalScore)
  - rationale: 1–2 sentences
  - confidence: integer 0..10000 (optional)
Return ONLY the JSON object. Do not include markdown fences.`;

export function buildReviewMessages(envelope: ReviewEnvelope): ChatMessage[] {
  const safe = {
    ...envelope,
    content: {
      ...envelope.content,
      proposal: {
        ...envelope.content.proposal,
        text: budgetProposal(envelope.content.proposal.text),
      },
    },
  };
  return buildPromptCacheMessages(buildSystemPrompt(REVIEW_INSTRUCTION, "review"), JSON.stringify(safe));
}

export function buildAuditMessages(envelope: AuditEnvelope): ChatMessage[] {
  const safe = {
    ...envelope,
    content: {
      ...envelope.content,
      proposal: {
        ...envelope.content.proposal,
        text: budgetProposal(envelope.content.proposal.text),
      },
      targets: envelope.content.targets.map((t) => ({
        ...t,
        report: budgetTargetReport(t.report),
      })),
    },
  };
  return buildPromptCacheMessages(buildSystemPrompt(AUDIT_INSTRUCTION, "audit"), JSON.stringify(safe));
}
