import Fastify, { type FastifyInstance } from "fastify";
import { keccak256, toUtf8Bytes } from "ethers";
import { ContentDB } from "./db.js";
import { ReviewArtifact, AuditArtifact } from "../shared/schemas.js";
import { canonicalHash, canonicalJson } from "../shared/canonical.js";

export interface ServerOptions {
  dbPath: string;
  logger?: boolean;
}

export function buildServer(opts: ServerOptions): { app: FastifyInstance; db: ContentDB } {
  const db = new ContentDB(opts.dbPath);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });

  app.get("/health", async () => ({ ok: true }));

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

  app.post("/reports", async (req, reply) => {
    const parsed = ReviewArtifact.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_artifact", issues: parsed.error.issues };
    }
    const artifact = parsed.data;
    const json = canonicalJson(artifact);
    const hash = canonicalHash(artifact);
    db.upsertBlob("reports", { hash, json });
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
    const parsed = AuditArtifact.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_artifact", issues: parsed.error.issues };
    }
    const artifact = parsed.data;
    const json = canonicalJson(artifact);
    const hash = canonicalHash(artifact);
    db.upsertBlob("audits", { hash, json });
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

  return { app, db };
}
