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

export interface AgentContextEventRow {
  id: number;
  requestId: string;
  agentKey: string;
  agent: string;
  eventType: string;
  phase: string | null;
  status: string | null;
  detail: string | null;
  payloadJson: string;
  createdAt: number;
}

export interface AgentQaHistoryRow {
  id: number;
  requestId: string;
  agentKey: string;
  agent: string;
  sessionId: string;
  question: string;
  answer: string;
  confidence: number;
  contextSummaryJson: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  createdAt: number;
}

export interface AgentScoreReportRow {
  requestId: string;
  agentKey: string;
  agent: string;
  reportJson: string;
  contextSummaryJson: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  createdAt: number;
}

export interface RequestFinalReportRow {
  requestId: string;
  reportJson: string;
  agentCount: number;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  createdAt: number;
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
      CREATE TABLE IF NOT EXISTS agent_context_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        agent_key TEXT NOT NULL,
        agent TEXT NOT NULL,
        event_type TEXT NOT NULL,
        phase TEXT,
        status TEXT,
        detail TEXT,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      );
      CREATE INDEX IF NOT EXISTS agent_context_events_lookup
        ON agent_context_events (request_id, agent_key, created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS agent_qa_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        agent_key TEXT NOT NULL,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        context_summary_json TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_qa_history_lookup
        ON agent_qa_history (request_id, agent_key, session_id, created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS agent_score_reports (
        request_id TEXT NOT NULL,
        agent_key TEXT NOT NULL,
        agent TEXT NOT NULL,
        report_json TEXT NOT NULL,
        context_summary_json TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (request_id, agent_key)
      );
      CREATE TABLE IF NOT EXISTS request_final_reports (
        request_id TEXT PRIMARY KEY,
        report_json TEXT NOT NULL,
        agent_count INTEGER NOT NULL,
        model TEXT NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        created_at INTEGER NOT NULL
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
    this.appendAgentContextEvent({
      requestId: row.requestId,
      agentKey: row.agentKey,
      agent: row.agent,
      eventType: "status_update",
      phase: row.phase,
      status: row.status,
      detail: row.detail ?? null,
      payloadJson: row.payloadJson,
    });
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

  appendAgentContextEvent(row: {
    requestId: string;
    agentKey: string;
    agent: string;
    eventType: string;
    phase?: string | null;
    status?: string | null;
    detail?: string | null;
    payloadJson: string;
  }): AgentContextEventRow {
    const info = this.db
      .prepare(
        `INSERT INTO agent_context_events (
           request_id,
           agent_key,
           agent,
           event_type,
           phase,
           status,
           detail,
           payload_json
         ) VALUES (
           @requestId,
           @agentKey,
           @agent,
           @eventType,
           @phase,
           @status,
           @detail,
           @payloadJson
         )`,
      )
      .run({
        ...row,
        phase: row.phase ?? null,
        status: row.status ?? null,
        detail: row.detail ?? null,
      });
    return this.db
      .prepare(
        `SELECT
           id,
           request_id AS requestId,
           agent_key AS agentKey,
           agent,
           event_type AS eventType,
           phase,
           status,
           detail,
           payload_json AS payloadJson,
           created_at AS createdAt
         FROM agent_context_events
         WHERE id = ?`,
      )
      .get(info.lastInsertRowid) as AgentContextEventRow;
  }

  listAgentContextEvents(requestId: string, agentKey: string, limit: number): AgentContextEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           request_id AS requestId,
           agent_key AS agentKey,
           agent,
           event_type AS eventType,
           phase,
           status,
           detail,
           payload_json AS payloadJson,
           created_at AS createdAt
         FROM agent_context_events
         WHERE request_id = ? AND agent_key = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(requestId, agentKey, limit) as AgentContextEventRow[];
    return rows.reverse();
  }

  insertAgentQaHistory(row: {
    requestId: string;
    agentKey: string;
    agent: string;
    sessionId: string;
    question: string;
    answer: string;
    confidence: number;
    contextSummaryJson: string;
    model: string;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    createdAt: number;
  }): AgentQaHistoryRow {
    const info = this.db
      .prepare(
        `INSERT INTO agent_qa_history (
           request_id,
           agent_key,
           agent,
           session_id,
           question,
           answer,
           confidence,
           context_summary_json,
           model,
           prompt_tokens,
           completion_tokens,
           total_tokens,
           created_at
         ) VALUES (
           @requestId,
           @agentKey,
           @agent,
           @sessionId,
           @question,
           @answer,
           @confidence,
           @contextSummaryJson,
           @model,
           @promptTokens,
           @completionTokens,
           @totalTokens,
           @createdAt
         )`,
      )
      .run({
        ...row,
        promptTokens: row.promptTokens ?? null,
        completionTokens: row.completionTokens ?? null,
        totalTokens: row.totalTokens ?? null,
      });
    return this.db
      .prepare(
        `SELECT
           id,
           request_id AS requestId,
           agent_key AS agentKey,
           agent,
           session_id AS sessionId,
           question,
           answer,
           confidence,
           context_summary_json AS contextSummaryJson,
           model,
           prompt_tokens AS promptTokens,
           completion_tokens AS completionTokens,
           total_tokens AS totalTokens,
           created_at AS createdAt
         FROM agent_qa_history
         WHERE id = ?`,
      )
      .get(info.lastInsertRowid) as AgentQaHistoryRow;
  }

  listAgentQaHistory(requestId: string, agentKey: string, sessionId: string, limit: number): AgentQaHistoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           request_id AS requestId,
           agent_key AS agentKey,
           agent,
           session_id AS sessionId,
           question,
           answer,
           confidence,
           context_summary_json AS contextSummaryJson,
           model,
           prompt_tokens AS promptTokens,
           completion_tokens AS completionTokens,
           total_tokens AS totalTokens,
           created_at AS createdAt
         FROM agent_qa_history
         WHERE request_id = ? AND agent_key = ? AND session_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(requestId, agentKey, sessionId, limit) as AgentQaHistoryRow[];
    return rows.reverse();
  }

  getAgentScoreReport(requestId: string, agentKey: string): AgentScoreReportRow | undefined {
    return this.db
      .prepare(
        `SELECT
           request_id AS requestId,
           agent_key AS agentKey,
           agent,
           report_json AS reportJson,
           context_summary_json AS contextSummaryJson,
           model,
           prompt_tokens AS promptTokens,
           completion_tokens AS completionTokens,
           total_tokens AS totalTokens,
           created_at AS createdAt
         FROM agent_score_reports
         WHERE request_id = ? AND agent_key = ?`,
      )
      .get(requestId, agentKey) as AgentScoreReportRow | undefined;
  }

  upsertAgentScoreReport(row: {
    requestId: string;
    agentKey: string;
    agent: string;
    reportJson: string;
    contextSummaryJson: string;
    model: string;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    createdAt: number;
  }): AgentScoreReportRow {
    this.db
      .prepare(
        `INSERT INTO agent_score_reports (
           request_id,
           agent_key,
           agent,
           report_json,
           context_summary_json,
           model,
           prompt_tokens,
           completion_tokens,
           total_tokens,
           created_at
         ) VALUES (
           @requestId,
           @agentKey,
           @agent,
           @reportJson,
           @contextSummaryJson,
           @model,
           @promptTokens,
           @completionTokens,
           @totalTokens,
           @createdAt
         )
         ON CONFLICT(request_id, agent_key) DO UPDATE SET
           agent=@agent,
           report_json=@reportJson,
           context_summary_json=@contextSummaryJson,
           model=@model,
           prompt_tokens=@promptTokens,
           completion_tokens=@completionTokens,
           total_tokens=@totalTokens,
           created_at=@createdAt`,
      )
      .run({
        ...row,
        promptTokens: row.promptTokens ?? null,
        completionTokens: row.completionTokens ?? null,
        totalTokens: row.totalTokens ?? null,
      });
    return this.getAgentScoreReport(row.requestId, row.agentKey)!;
  }

  getRequestFinalReport(requestId: string): RequestFinalReportRow | undefined {
    return this.db
      .prepare(
        `SELECT
           request_id AS requestId,
           report_json AS reportJson,
           agent_count AS agentCount,
           model,
           prompt_tokens AS promptTokens,
           completion_tokens AS completionTokens,
           total_tokens AS totalTokens,
           created_at AS createdAt
         FROM request_final_reports
         WHERE request_id = ?`,
      )
      .get(requestId) as RequestFinalReportRow | undefined;
  }

  upsertRequestFinalReport(row: {
    requestId: string;
    reportJson: string;
    agentCount: number;
    model: string;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    createdAt: number;
  }): RequestFinalReportRow {
    this.db
      .prepare(
        `INSERT INTO request_final_reports (
           request_id,
           report_json,
           agent_count,
           model,
           prompt_tokens,
           completion_tokens,
           total_tokens,
           created_at
         ) VALUES (
           @requestId,
           @reportJson,
           @agentCount,
           @model,
           @promptTokens,
           @completionTokens,
           @totalTokens,
           @createdAt
         )
         ON CONFLICT(request_id) DO UPDATE SET
           report_json=@reportJson,
           agent_count=@agentCount,
           model=@model,
           prompt_tokens=@promptTokens,
           completion_tokens=@completionTokens,
           total_tokens=@totalTokens,
           created_at=@createdAt`,
      )
      .run({
        ...row,
        promptTokens: row.promptTokens ?? null,
        completionTokens: row.completionTokens ?? null,
        totalTokens: row.totalTokens ?? null,
      });
    return this.getRequestFinalReport(row.requestId)!;
  }

  close(): void {
    this.db.close();
  }
}
