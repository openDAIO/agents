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
}
