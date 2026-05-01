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
    if (!res.ok) throw new Error(`getRequestDocument: ${res.status} ${await res.text()}`);
    return (await res.json()) as RequestDocumentRecord;
  }

  async putReport(artifact: ReviewArtifact): Promise<ReportRecord> {
    const res = await fetch(this.url("/reports"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(artifact),
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

  async putAudit(artifact: AuditArtifact): Promise<AuditRecord> {
    const res = await fetch(this.url("/audits"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(artifact),
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
  }): Promise<AgentStatusRecord> {
    const res = await fetch(this.url("/agent-status"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...input, requestId: input.requestId.toString() }),
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
}
