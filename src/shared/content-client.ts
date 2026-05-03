import type { ReviewArtifact, AuditArtifact } from "./schemas.js";

export interface ProposalRecord {
  uri: string;
  id: string;
  hash: string;
  mimeType: string;
  text: string;
}

export interface ReportRecord {
  uri: string;
  hash: string;
  artifact: ReviewArtifact;
}

export interface AuditRecord {
  uri: string;
  hash: string;
  artifact: AuditArtifact;
}

export interface VerifiedDocumentRecord {
  verified: {
    requestId: string;
    requester: string;
    proposalURI: string;
    proposalHash: string;
    rubricHash: string;
    domainMask: string;
    tier: number;
    tierName: string;
    priorityFee: string;
    txHash: string;
    paymentFunction: string;
    paymentToken: string;
    amountPaid: string;
    blockNumber: number;
    status: number;
    statusName: string;
  };
  proposal: ProposalRecord;
}

export interface RequestDocumentRecord extends VerifiedDocumentRecord {
  updatedAt: number;
}

export interface ChainStatusRecord {
  requestId: string;
  requester: string;
  status: number;
  statusName: string;
  feePaid: string;
  priorityFee: string;
  retryCount: string;
  committeeEpoch: string;
  auditEpoch: string;
  activePriority: string;
  lowConfidence: boolean;
}

export interface AgentStatusRecord {
  requestId: string;
  agent: string;
  phase: string;
  status: string;
  detail: string | null;
  payload: unknown;
  updatedAt: number;
}

export interface AgentReasonsRecord {
  requestId: string;
  agent: string;
  rawThinking: {
    available: boolean;
    reason: string;
  };
  review: null | {
    reportHash: string;
    proposalScore: number;
    summary: string;
    recommendation: string;
    confidence: number;
    rubricAssessments: unknown[];
    strengths: string[];
    weaknesses: string[];
    risks: string[];
    rawFinalArtifact: ReviewArtifact;
  };
  audit: null | {
    auditHash: string;
    targetEvaluations: Array<{ targetReviewer: string; score: number; rationale: string }>;
    rawFinalArtifact: AuditArtifact;
  };
}

export interface AgentQaContextUsed {
  hasDocument: boolean;
  hasReview: boolean;
  hasAudit: boolean;
  agentStatus: string | null;
  historyUsed: number;
  eventsUsed: number;
  chainStatus: string | null;
}

export interface AgentQaRecord {
  id?: number;
  requestId: string;
  agent: string;
  sessionId: string;
  question?: string;
  answer: string;
  confidence: number;
  contextUsed: AgentQaContextUsed;
  model: string;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
  createdAt: number;
}

export interface AgentQaHistoryRecord {
  requestId: string;
  agent: string;
  sessionId: string;
  history: AgentQaRecord[];
}

export interface USDAIORequestIntentRecord {
  requester: string;
  id: string;
  proposalURI: string;
  proposalURIHash: string;
  proposalHash: string;
  rubricHash: string;
  domainMask: string;
  tier: number;
  tierName: string;
  priorityFee: string;
  nonce: string;
  deadline: string;
  typedData: {
    domain: {
      name: string;
      version: string;
      chainId: number;
      verifyingContract: string;
    };
    primaryType: "RequestIntent";
    types: Record<string, Array<{ name: string; type: string }>>;
    message: Record<string, string | number>;
  };
}

export interface RelayedDocumentRecord {
  relayed: {
    relayer: string;
    requestId: string;
    txHash: string;
    blockNumber: number;
  };
  document: RequestDocumentRecord;
}

export class ContentServiceError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`${operation}: ${status} ${responseBody}`);
    this.name = "ContentServiceError";
  }
}

export function isContentServiceNotFound(err: unknown, operation?: string): boolean {
  return (
    err instanceof ContentServiceError &&
    err.status === 404 &&
    (operation === undefined || err.operation === operation)
  );
}

export class ContentServiceClient {
  constructor(private readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async health(): Promise<boolean> {
    const res = await fetch(this.url("/health"));
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  }

  async putProposal(input: { id: string; text: string; mimeType: string }): Promise<ProposalRecord> {
    const res = await fetch(this.url("/proposals"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`putProposal: ${res.status} ${await res.text()}`);
    return (await res.json()) as ProposalRecord;
  }

  async createUSDAIORequestIntent(input: {
    requester: string;
    id?: string;
    proposalURI?: string;
    text: string;
    rubricHash?: string;
    domainMask?: string | number;
    tier?: number;
    priorityFee?: string | number;
    deadline?: string | number;
    mimeType?: string;
  }): Promise<USDAIORequestIntentRecord> {
    const res = await fetch(this.url("/request-intents/usdaio"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`createUSDAIORequestIntent: ${res.status} ${await res.text()}`);
    return (await res.json()) as USDAIORequestIntentRecord;
  }

  async submitRelayedRequestDocument(input: {
    requester: string;
    signature: string;
    deadline: string | number;
    id?: string;
    proposalURI?: string;
    text: string;
    rubricHash?: string;
    domainMask?: string | number;
    tier?: number;
    priorityFee?: string | number;
    mimeType?: string;
  }): Promise<RelayedDocumentRecord> {
    const res = await fetch(this.url("/requests/relayed-document"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`submitRelayedRequestDocument: ${res.status} ${await res.text()}`);
    return (await res.json()) as RelayedDocumentRecord;
  }

  async submitRequestDocument(input: {
    requestId: string | bigint | number;
    txHash: string;
    id?: string;
    requester?: string;
    text: string;
    mimeType?: string;
  }): Promise<VerifiedDocumentRecord> {
    const { requestId, ...body } = input;
    const res = await fetch(this.url(`/requests/${requestId.toString()}/document`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`submitRequestDocument: ${res.status} ${await res.text()}`);
    return (await res.json()) as VerifiedDocumentRecord;
  }

  async recoverRequestDocumentFromTx(input: {
    txHash: string;
    id?: string;
    requester?: string;
    text: string;
    mimeType?: string;
  }): Promise<VerifiedDocumentRecord> {
    const res = await fetch(this.url("/requests/document-from-tx"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`recoverRequestDocumentFromTx: ${res.status} ${await res.text()}`);
    return (await res.json()) as VerifiedDocumentRecord;
  }

  async getProposal(id: string): Promise<ProposalRecord> {
    const res = await fetch(this.url(`/proposals/${encodeURIComponent(id)}`));
    if (!res.ok) throw new Error(`getProposal(${id}): ${res.status}`);
    return (await res.json()) as ProposalRecord;
  }

  async resolveProposal(uri: string): Promise<ProposalRecord> {
    const m = uri.match(/^content:\/\/proposals\/(.+)$/);
    if (!m) throw new Error(`unsupported proposal uri: ${uri}`);
    return this.getProposal(m[1]!);
  }

  async getRequestDocument(requestId: string | bigint | number): Promise<RequestDocumentRecord> {
    const res = await fetch(this.url(`/requests/${requestId.toString()}/document`));
    if (!res.ok) throw new ContentServiceError("getRequestDocument", res.status, await res.text());
    return (await res.json()) as RequestDocumentRecord;
  }

  async getChainStatus(requestId: string | bigint | number): Promise<ChainStatusRecord> {
    const res = await fetch(this.url(`/requests/${requestId.toString()}/chain-status`));
    if (!res.ok) throw new ContentServiceError("getChainStatus", res.status, await res.text());
    return (await res.json()) as ChainStatusRecord;
  }

  async putReport(artifact: ReviewArtifact, signature?: string): Promise<ReportRecord> {
    const res = await fetch(this.url("/reports"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signature ? { artifact, signature } : artifact),
    });
    if (!res.ok) throw new Error(`putReport: ${res.status} ${await res.text()}`);
    return (await res.json()) as ReportRecord;
  }

  async getReport(hash: string): Promise<ReportRecord> {
    const res = await fetch(this.url(`/reports/${hash}`));
    if (!res.ok) throw new Error(`getReport(${hash}): ${res.status}`);
    return (await res.json()) as ReportRecord;
  }

  async resolveReport(uri: string): Promise<ReportRecord> {
    const m = uri.match(/^content:\/\/reports\/(0x[a-fA-F0-9]{64})$/);
    if (!m) throw new Error(`unsupported report uri: ${uri}`);
    return this.getReport(m[1]!);
  }

  async putAudit(artifact: AuditArtifact, signature?: string): Promise<AuditRecord> {
    const res = await fetch(this.url("/audits"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signature ? { artifact, signature } : artifact),
    });
    if (!res.ok) throw new Error(`putAudit: ${res.status} ${await res.text()}`);
    return (await res.json()) as AuditRecord;
  }

  async putAgentStatus(input: {
    requestId: string | bigint | number;
    agent: string;
    phase: string;
    status: string;
    detail?: string;
    payload?: Record<string, unknown>;
  }, signature?: string): Promise<AgentStatusRecord> {
    const res = await fetch(this.url("/agent-status"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, requestId: input.requestId.toString(), ...(signature ? { signature } : {}) }),
    });
    if (!res.ok) throw new Error(`putAgentStatus: ${res.status} ${await res.text()}`);
    return (await res.json()) as AgentStatusRecord;
  }

  async getAgentStatus(requestId: string | bigint | number, agent: string): Promise<AgentStatusRecord> {
    const res = await fetch(this.url(`/requests/${requestId.toString()}/agents/${encodeURIComponent(agent)}/status`));
    if (!res.ok) throw new Error(`getAgentStatus: ${res.status} ${await res.text()}`);
    return (await res.json()) as AgentStatusRecord;
  }

  async getAgentReasons(requestId: string | bigint | number, agent: string): Promise<AgentReasonsRecord> {
    const res = await fetch(this.url(`/requests/${requestId.toString()}/agents/${encodeURIComponent(agent)}/reasons`));
    if (!res.ok) throw new Error(`getAgentReasons: ${res.status} ${await res.text()}`);
    return (await res.json()) as AgentReasonsRecord;
  }

  async askAgent(input: {
    requestId: string | bigint | number;
    agent: string;
    question: string;
    sessionId?: string;
  }): Promise<AgentQaRecord> {
    const res = await fetch(
      this.url(`/requests/${input.requestId.toString()}/agents/${encodeURIComponent(input.agent)}/ask`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: input.question, ...(input.sessionId ? { sessionId: input.sessionId } : {}) }),
      },
    );
    if (!res.ok) throw new Error(`askAgent: ${res.status} ${await res.text()}`);
    return (await res.json()) as AgentQaRecord;
  }

  async getAgentQaHistory(input: {
    requestId: string | bigint | number;
    agent: string;
    sessionId?: string;
    limit?: number;
  }): Promise<AgentQaHistoryRecord> {
    const params = new URLSearchParams();
    if (input.sessionId) params.set("sessionId", input.sessionId);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const res = await fetch(
      this.url(`/requests/${input.requestId.toString()}/agents/${encodeURIComponent(input.agent)}/qa-history${suffix}`),
    );
    if (!res.ok) throw new Error(`getAgentQaHistory: ${res.status} ${await res.text()}`);
    return (await res.json()) as AgentQaHistoryRecord;
  }
}
