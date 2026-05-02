import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface ReviewState {
  proposalScore: number;
  reportHash: string;
  reportURI: string;
  resultHash: string;
  seed: string;
  accepted?: boolean;
  notAcceptedReason?: string;
  commitTx?: string;
  revealTx?: string;
}

export interface AuditState {
  targets: string[];
  scores: number[];
  rationales?: string[];
  auditHash?: string;
  auditURI?: string;
  resultHash: string;
  seed: string;
  accepted?: boolean;
  notAcceptedReason?: string;
  commitTx?: string;
  revealTx?: string;
}

export interface RequestState {
  requestId: string;
  reviewer: string;
  phase: string;
  review?: ReviewState;
  audit?: AuditState;
  vrf?: {
    reviewPhaseStartBlock?: string;
    auditPhaseStartBlock?: string;
    committeeEpoch?: string;
    auditEpoch?: string;
  };
}

export interface EventCursorState {
  lastBlock: number;
  updatedAt: number;
}

export class StateStore {
  constructor(private readonly dir: string, private readonly key: Buffer) {
    mkdirSync(dir, { recursive: true });
  }

  static fromKey(dir: string, hexKey: string): StateStore {
    const key = Buffer.from(hexKey.replace(/^0x/, ""), "hex");
    if (key.length !== 32) throw new Error(`AGENT_STATE_KEY must be 32 bytes hex (got ${key.length})`);
    return new StateStore(dir, key);
  }

  static withGeneratedKey(dir: string): { store: StateStore; keyHex: string } {
    const buf = crypto.randomBytes(32);
    return { store: new StateStore(dir, buf), keyHex: `0x${buf.toString("hex")}` };
  }

  private filePath(requestId: string): string {
    return path.join(this.dir, `req-${requestId}.json`);
  }

  private metadataPath(name: string): string {
    return path.join(this.dir, `${name}.json`);
  }

  encryptSeed(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("chacha20-poly1305", this.key, iv, { authTagLength: 16 });
    const enc = Buffer.concat([cipher.update(Buffer.from(plain.replace(/^0x/, ""), "hex")), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `0x${iv.toString("hex")}${tag.toString("hex")}${enc.toString("hex")}`;
  }

  decryptSeed(blob: string): string {
    const buf = Buffer.from(blob.replace(/^0x/, ""), "hex");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv("chacha20-poly1305", this.key, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    return `0x${plain.toString("hex")}`;
  }

  load(requestId: string): RequestState | undefined {
    const fp = this.filePath(requestId);
    if (!existsSync(fp)) return undefined;
    return JSON.parse(readFileSync(fp, "utf8")) as RequestState;
  }

  save(state: RequestState): void {
    writeFileSync(this.filePath(state.requestId), JSON.stringify(state, null, 2));
  }

  loadEventCursor(name = "core-events"): EventCursorState | undefined {
    const fp = this.metadataPath(name);
    if (!existsSync(fp)) return undefined;
    const parsed = JSON.parse(readFileSync(fp, "utf8")) as EventCursorState;
    if (!Number.isFinite(parsed.lastBlock) || parsed.lastBlock < 0) return undefined;
    return parsed;
  }

  saveEventCursor(cursor: EventCursorState, name = "core-events"): void {
    writeFileSync(this.metadataPath(name), JSON.stringify(cursor, null, 2));
  }
}
