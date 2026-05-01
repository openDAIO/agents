import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";

export interface ProposalRow {
  id: string;
  hash: string;
  mimeType: string;
  text: string;
}

export interface RequestDocumentRow {
  requestId: string;
  requester: string;
  proposalUri: string;
  proposalHash: string;
  rubricHash: string;
  domainMask: string;
  tier: number;
  priorityFee: string;
  paymentTxHash: string;
  paymentFunction: string;
  paymentToken: string;
  amountPaid: string;
  blockNumber: number;
  status: number;
  statusName: string;
  proposalId: string;
  updatedAt: number;
}

export interface BlobRow {
  hash: string;
  json: string;
}

export interface AgentStatusRow {
  requestId: string;
  agentKey: string;
  agent: string;
  phase: string;
  status: string;
  detail: string | null;
  payloadJson: string;
  updatedAt: number;
}

export class ContentDB {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS request_documents (
        request_id TEXT PRIMARY KEY,
        requester TEXT NOT NULL,
        proposal_uri TEXT NOT NULL,
        proposal_hash TEXT NOT NULL,
        rubric_hash TEXT NOT NULL,
        domain_mask TEXT NOT NULL,
        tier INTEGER NOT NULL,
        priority_fee TEXT NOT NULL,
        payment_tx_hash TEXT NOT NULL,
        payment_function TEXT NOT NULL,
        payment_token TEXT NOT NULL,
        amount_paid TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        status INTEGER NOT NULL,
        status_name TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS reports (
        hash TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS audits (
        hash TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS review_index (
        request_id TEXT NOT NULL,
        reviewer_key TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (request_id, reviewer_key)
      );
      CREATE TABLE IF NOT EXISTS audit_index (
        request_id TEXT NOT NULL,
        auditor_key TEXT NOT NULL,
        auditor TEXT NOT NULL,
        hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (request_id, auditor_key)
      );
      CREATE TABLE IF NOT EXISTS agent_status (
        request_id TEXT NOT NULL,
        agent_key TEXT NOT NULL,
        agent TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (request_id, agent_key)
      );
    `);
  }

  upsertProposal(row: ProposalRow): void {
    this.db
      .prepare(
        `INSERT INTO proposals (id, hash, mimeType, text) VALUES (@id, @hash, @mimeType, @text)
         ON CONFLICT(id) DO UPDATE SET hash=@hash, mimeType=@mimeType, text=@text`,
      )
      .run(row);
  }

  getProposal(id: string): ProposalRow | undefined {
    return this.db.prepare(`SELECT id, hash, mimeType, text FROM proposals WHERE id = ?`).get(id) as
      | ProposalRow
      | undefined;
  }

  upsertRequestDocument(row: Omit<RequestDocumentRow, "updatedAt">): void {
    this.db
      .prepare(
        `INSERT INTO request_documents (
           request_id,
           requester,
           proposal_uri,
           proposal_hash,
           rubric_hash,
           domain_mask,
           tier,
           priority_fee,
           payment_tx_hash,
           payment_function,
           payment_token,
           amount_paid,
           block_number,
           status,
           status_name,
           proposal_id
         ) VALUES (
           @requestId,
           @requester,
           @proposalUri,
           @proposalHash,
           @rubricHash,
           @domainMask,
           @tier,
           @priorityFee,
           @paymentTxHash,
           @paymentFunction,
           @paymentToken,
           @amountPaid,
           @blockNumber,
           @status,
           @statusName,
           @proposalId
         )
         ON CONFLICT(request_id) DO UPDATE SET
           requester=@requester,
           proposal_uri=@proposalUri,
           proposal_hash=@proposalHash,
           rubric_hash=@rubricHash,
           domain_mask=@domainMask,
           tier=@tier,
           priority_fee=@priorityFee,
           payment_tx_hash=@paymentTxHash,
           payment_function=@paymentFunction,
           payment_token=@paymentToken,
           amount_paid=@amountPaid,
           block_number=@blockNumber,
           status=@status,
           status_name=@statusName,
           proposal_id=@proposalId,
           updated_at=strftime('%s','now')`,
      )
      .run(row);
  }

  getRequestDocument(requestId: string): RequestDocumentRow | undefined {
    return this.db
      .prepare(
        `SELECT
           request_id AS requestId,
           requester,
           proposal_uri AS proposalUri,
           proposal_hash AS proposalHash,
           rubric_hash AS rubricHash,
           domain_mask AS domainMask,
           tier,
           priority_fee AS priorityFee,
           payment_tx_hash AS paymentTxHash,
           payment_function AS paymentFunction,
           payment_token AS paymentToken,
           amount_paid AS amountPaid,
           block_number AS blockNumber,
           status,
           status_name AS statusName,
           proposal_id AS proposalId,
           updated_at AS updatedAt
         FROM request_documents
         WHERE request_id = ?`,
      )
      .get(requestId) as RequestDocumentRow | undefined;
  }

  upsertBlob(table: "reports" | "audits", row: BlobRow): void {
    this.db
      .prepare(
        `INSERT INTO ${table} (hash, json) VALUES (@hash, @json)
         ON CONFLICT(hash) DO UPDATE SET json=@json`,
      )
      .run(row);
  }

  getBlob(table: "reports" | "audits", hash: string): BlobRow | undefined {
    return this.db.prepare(`SELECT hash, json FROM ${table} WHERE hash = ?`).get(hash) as
      | BlobRow
      | undefined;
  }

  indexReviewArtifact(row: { requestId: string; reviewerKey: string; reviewer: string; hash: string }): void {
    this.db
      .prepare(
        `INSERT INTO review_index (request_id, reviewer_key, reviewer, hash)
         VALUES (@requestId, @reviewerKey, @reviewer, @hash)
         ON CONFLICT(request_id, reviewer_key) DO UPDATE SET
           reviewer=@reviewer,
           hash=@hash,
           updated_at=strftime('%s','now')`,
      )
      .run(row);
  }

  indexAuditArtifact(row: { requestId: string; auditorKey: string; auditor: string; hash: string }): void {
    this.db
      .prepare(
        `INSERT INTO audit_index (request_id, auditor_key, auditor, hash)
         VALUES (@requestId, @auditorKey, @auditor, @hash)
         ON CONFLICT(request_id, auditor_key) DO UPDATE SET
           auditor=@auditor,
           hash=@hash,
           updated_at=strftime('%s','now')`,
      )
      .run(row);
  }

  findReviewArtifact(requestId: string, reviewerKey: string): BlobRow | undefined {
    return this.db
      .prepare(
        `SELECT reports.hash, reports.json
         FROM review_index
         JOIN reports ON reports.hash = review_index.hash
         WHERE review_index.request_id = ? AND review_index.reviewer_key = ?`,
      )
      .get(requestId, reviewerKey) as BlobRow | undefined;
  }

  findAuditArtifact(requestId: string, auditorKey: string): BlobRow | undefined {
    return this.db
      .prepare(
        `SELECT audits.hash, audits.json
         FROM audit_index
         JOIN audits ON audits.hash = audit_index.hash
         WHERE audit_index.request_id = ? AND audit_index.auditor_key = ?`,
      )
      .get(requestId, auditorKey) as BlobRow | undefined;
  }

  listBlobs(table: "reports" | "audits"): BlobRow[] {
    return this.db.prepare(`SELECT hash, json FROM ${table}`).all() as BlobRow[];
  }

  upsertAgentStatus(row: {
    requestId: string;
    agentKey: string;
    agent: string;
    phase: string;
    status: string;
    detail?: string | null;
    payloadJson: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO agent_status (request_id, agent_key, agent, phase, status, detail, payload_json)
         VALUES (@requestId, @agentKey, @agent, @phase, @status, @detail, @payloadJson)
         ON CONFLICT(request_id, agent_key) DO UPDATE SET
           agent=@agent,
           phase=@phase,
           status=@status,
           detail=@detail,
           payload_json=@payloadJson,
           updated_at=strftime('%s','now')`,
      )
      .run({ ...row, detail: row.detail ?? null });
  }

  getAgentStatus(requestId: string, agentKey: string): AgentStatusRow | undefined {
    return this.db
      .prepare(
        `SELECT
           request_id AS requestId,
           agent_key AS agentKey,
           agent,
           phase,
           status,
           detail,
           payload_json AS payloadJson,
           updated_at AS updatedAt
         FROM agent_status
         WHERE request_id = ? AND agent_key = ?`,
      )
      .get(requestId, agentKey) as AgentStatusRow | undefined;
  }

  listAgentStatuses(requestId: string): AgentStatusRow[] {
    return this.db
      .prepare(
        `SELECT
           request_id AS requestId,
           agent_key AS agentKey,
           agent,
           phase,
           status,
           detail,
           payload_json AS payloadJson,
           updated_at AS updatedAt
         FROM agent_status
         WHERE request_id = ?
         ORDER BY updated_at DESC, agent ASC`,
      )
      .all(requestId) as AgentStatusRow[];
  }

  close(): void {
    this.db.close();
  }
}
