import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";

export interface ProposalRow {
  id: string;
  hash: string;
  mimeType: string;
  text: string;
}

export interface BlobRow {
  hash: string;
  json: string;
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

  close(): void {
    this.db.close();
  }
}
