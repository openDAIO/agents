import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { getAddress, Interface, NonceManager, Wallet, keccak256, toUtf8Bytes, type Provider } from "ethers";
import { z } from "zod";
import { ContentDB } from "./db.js";
import { ReviewArtifact, AuditArtifact } from "../shared/schemas.js";
import { canonicalHash, canonicalJson } from "../shared/canonical.js";
import { agentArtifactMessage, agentStatusMessage, verifyAgentSignature } from "../shared/agent-signing.js";
import { Artifacts } from "../shared/abis.js";
import type { DeploymentSnapshot } from "../shared/types.js";
import { RequestStatus, Tier } from "../shared/types.js";
import { loadContracts } from "../reviewer-agent/chain/contracts.js";
import { makeRpcProvider, parseRpcUrls, rpcFailoverOptionsFromEnv } from "../shared/rpc.js";

export interface ServerOptions {
  dbPath: string;
  logger?: boolean;
  chain?: {
    rpcUrl?: string;
    rpcUrls?: string;
    deploymentPath?: string;
  };
  relayer?: {
    privateKey?: string;
    confirmations?: number;
  };
  requireAgentSignatures?: boolean;
}

const HexAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const HexTxHash = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const HexBytes32 = z.string().regex(/^0x[a-fA-F0-9]{64}$/);
const HexSignature = z.string().regex(/^0x[a-fA-F0-9]{130}$/);
const DecimalId = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform((v) => String(v));
const UintString = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((v) => String(v));

const SubmitDocumentBody = z.object({
  txHash: HexTxHash,
  requester: HexAddress.optional(),
  id: z.string().min(1).max(200).optional(),
  text: z.string().min(1),
  mimeType: z.string().min(1).max(120).optional(),
});

const AgentStatusBody = z.object({
  requestId: DecimalId,
  agent: HexAddress,
  phase: z.string().min(1).max(80),
  status: z.string().min(1).max(80),
  detail: z.string().max(1000).optional(),
  payload: z.record(z.unknown()).optional().default({}),
  signature: HexSignature.optional(),
});

const ReviewArtifactBody = z.union([
  ReviewArtifact,
  z.object({
    artifact: ReviewArtifact,
    signature: HexSignature,
  }),
]);

const AuditArtifactBody = z.union([
  AuditArtifact,
  z.object({
    artifact: AuditArtifact,
    signature: HexSignature,
  }),
]);

const RequestIntentBody = z.object({
  requester: HexAddress,
  id: z.string().min(1).max(200).optional(),
  proposalURI: z.string().min(1).max(500).optional(),
  text: z.string().min(1),
  rubricHash: HexBytes32.optional(),
  domainMask: UintString.default("1"),
  tier: z.number().int().min(0).max(2).default(0),
  priorityFee: UintString.default("0"),
  deadline: UintString.optional(),
  mimeType: z.string().min(1).max(120).optional(),
});

const RelayedDocumentBody = RequestIntentBody.extend({
  deadline: UintString,
  signature: HexSignature,
});

const REQUEST_INTENT_TYPES = {
  RequestIntent: [
    { name: "requester", type: "address" },
    { name: "proposalURIHash", type: "bytes32" },
    { name: "proposalHash", type: "bytes32" },
    { name: "rubricHash", type: "bytes32" },
    { name: "domainMask", type: "uint256" },
    { name: "tier", type: "uint8" },
    { name: "priorityFee", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

const RAW_THINKING_NOTICE = {
  available: false,
  reason:
    "Raw hidden model reasoning is not stored or exposed. This API returns the model's final structured rationales and raw final artifacts.",
};

function addressKey(address: string): string {
  return getAddress(address).toLowerCase();
}

function loadDeploymentSnapshot(deploymentPath: string): DeploymentSnapshot {
  if (!existsSync(deploymentPath)) {
    throw new Error(`deployment snapshot not found at ${deploymentPath}`);
  }
  return JSON.parse(readFileSync(deploymentPath, "utf8")) as DeploymentSnapshot;
}

function proposalIdFromUri(uri: string): string | undefined {
  const m = uri.match(/^content:\/\/proposals\/(.+)$/);
  return m?.[1];
}

function normalizeProposalReference(input: { id?: string; proposalURI?: string }) {
  const proposalURI = input.proposalURI ?? (input.id ? `content://proposals/${input.id}` : undefined);
  if (!proposalURI) return { ok: false as const, error: "id_or_proposal_uri_required" };
  const idFromUri = proposalIdFromUri(proposalURI);
  if (!idFromUri) return { ok: false as const, error: "unsupported_proposal_uri", proposalURI };
  if (input.id && input.id !== idFromUri) {
    return { ok: false as const, error: "proposal_id_mismatch", expected: idFromUri, got: input.id };
  }
  return { ok: true as const, id: idFromUri, proposalURI };
}

function normalizeRequestIntentFields(input: {
  requester: string;
  id?: string;
  proposalURI?: string;
  text: string;
  rubricHash?: string;
  domainMask: string;
  tier: number;
  priorityFee: string;
  deadline?: string;
}) {
  const ref = normalizeProposalReference(input);
  if (!ref.ok) return ref;
  const proposalHash = keccak256(toUtf8Bytes(input.text));
  const rubricHash = input.rubricHash ?? keccak256(toUtf8Bytes(`${ref.id}:rubric`));
  return {
    ok: true as const,
    requester: getAddress(input.requester),
    id: ref.id,
    proposalURI: ref.proposalURI,
    proposalURIHash: keccak256(toUtf8Bytes(ref.proposalURI)),
    proposalHash,
    rubricHash,
    domainMask: input.domainMask,
    tier: input.tier,
    priorityFee: input.priorityFee,
    deadline: input.deadline,
  };
}

function serializeAgentStatus(row: ReturnType<ContentDB["getAgentStatus"]>) {
  if (!row) return undefined;
  return {
    requestId: row.requestId,
    agent: row.agent,
    phase: row.phase,
    status: row.status,
    detail: row.detail,
    payload: JSON.parse(row.payloadJson) as unknown,
    updatedAt: row.updatedAt,
  };
}

function serializeRequestDocument(db: ContentDB, requestId: string) {
  const row = db.getRequestDocument(requestId);
  if (!row) return undefined;
  const proposal = db.getProposal(row.proposalId);
  if (!proposal) return undefined;
  return {
    updatedAt: row.updatedAt,
    verified: {
      requestId: row.requestId,
      requester: row.requester,
      proposalURI: row.proposalUri,
      proposalHash: row.proposalHash,
      rubricHash: row.rubricHash,
      domainMask: row.domainMask,
      tier: row.tier,
      tierName: Tier[row.tier] ?? `Tier${row.tier}`,
      priorityFee: row.priorityFee,
      txHash: row.paymentTxHash,
      paymentFunction: row.paymentFunction,
      paymentToken: row.paymentToken,
      amountPaid: row.amountPaid,
      blockNumber: row.blockNumber,
      status: row.status,
      statusName: row.statusName,
    },
    proposal: {
      uri: row.proposalUri,
      id: proposal.id,
      hash: proposal.hash,
      mimeType: proposal.mimeType,
      text: proposal.text,
    },
  };
}

function findReviewArtifact(db: ContentDB, requestId: string, agent: string) {
  const key = addressKey(agent);
  const indexed = db.findReviewArtifact(requestId, key);
  if (indexed) return indexed;
  for (const row of db.listBlobs("reports")) {
    const parsed = ReviewArtifact.safeParse(JSON.parse(row.json));
    if (parsed.success && parsed.data.requestId === requestId && addressKey(parsed.data.reviewer) === key) {
      db.indexReviewArtifact({ requestId, reviewerKey: key, reviewer: getAddress(parsed.data.reviewer), hash: row.hash });
      return row;
    }
  }
  return undefined;
}

function findAuditArtifact(db: ContentDB, requestId: string, agent: string) {
  const key = addressKey(agent);
  const indexed = db.findAuditArtifact(requestId, key);
  if (indexed) return indexed;
  for (const row of db.listBlobs("audits")) {
    const parsed = AuditArtifact.safeParse(JSON.parse(row.json));
    if (parsed.success && parsed.data.requestId === requestId && addressKey(parsed.data.auditor) === key) {
      db.indexAuditArtifact({ requestId, auditorKey: key, auditor: getAddress(parsed.data.auditor), hash: row.hash });
      return row;
    }
  }
  return undefined;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function requireValidAgentSignature(input: {
  enabled: boolean;
  signer: string;
  message: string;
  signature?: string;
}): { ok: true } | { ok: false; code: number; error: string } {
  if (!input.enabled) return { ok: true };
  if (!input.signature) return { ok: false, code: 401, error: "agent_signature_required" };
  try {
    if (!verifyAgentSignature(input.signer, input.message, input.signature)) {
      return { ok: false, code: 403, error: "agent_signature_mismatch" };
    }
  } catch (err) {
    return { ok: false, code: 400, error: "invalid_agent_signature" };
  }
  return { ok: true };
}

function isNonceError(err: unknown): boolean {
  const text = formatError(err).toLowerCase();
  return text.includes("nonce") || text.includes("replacement transaction underpriced") || text.includes("already known");
}

async function verifyRequestTransaction(input: {
  requestId: string;
  txHash: string;
  requester?: string;
  textHash: string;
  deploymentPath: string;
  rpcUrl?: string;
  rpcUrls?: string;
}) {
  const deployment = loadDeploymentSnapshot(input.deploymentPath);
  const rpcUrls = parseRpcUrls(input.rpcUrl ?? deployment.rpcUrl, input.rpcUrls);
  const provider = makeRpcProvider(rpcUrls, rpcFailoverOptionsFromEnv());
  const paymentRouterAddress = getAddress(deployment.contracts.paymentRouter);
  const iface = new Interface(Artifacts.PaymentRouter().abi as never[]);
  const receipt = await provider.getTransactionReceipt(input.txHash);
  if (!receipt) return { ok: false as const, code: 404, error: "tx_not_found_or_pending" };
  if (receipt.status !== 1) return { ok: false as const, code: 400, error: "tx_failed" };

  const tx = await provider.getTransaction(input.txHash);
  if (!tx) return { ok: false as const, code: 404, error: "tx_not_found" };
  if (!tx.to || getAddress(tx.to) !== paymentRouterAddress) {
    return { ok: false as const, code: 400, error: "tx_not_sent_to_payment_router" };
  }

  const parsedTx = iface.parseTransaction({ data: tx.data, value: tx.value });
  if (!parsedTx) return { ok: false as const, code: 400, error: "unsupported_payment_router_call" };

  let proposalURI: string;
  let proposalHash: string;
  let rubricHash: string;
  let domainMask: bigint;
  let tier: number;
  let priorityFee: bigint;
  let expectedRequester: string;
  switch (parsedTx.name) {
    case "createRequestWithUSDAIO":
      proposalURI = String(parsedTx.args[0]);
      proposalHash = String(parsedTx.args[1]);
      rubricHash = String(parsedTx.args[2]);
      domainMask = BigInt(parsedTx.args[3]);
      tier = Number(parsedTx.args[4]);
      priorityFee = BigInt(parsedTx.args[5]);
      expectedRequester = getAddress(tx.from);
      break;
    case "createRequestWithUSDAIOBySig":
      expectedRequester = getAddress(String(parsedTx.args[0]));
      proposalURI = String(parsedTx.args[1]);
      proposalHash = String(parsedTx.args[2]);
      rubricHash = String(parsedTx.args[3]);
      domainMask = BigInt(parsedTx.args[4]);
      tier = Number(parsedTx.args[5]);
      priorityFee = BigInt(parsedTx.args[6]);
      break;
    case "createRequestWithERC20":
      proposalURI = String(parsedTx.args[3]);
      proposalHash = String(parsedTx.args[4]);
      rubricHash = String(parsedTx.args[5]);
      domainMask = BigInt(parsedTx.args[6]);
      tier = Number(parsedTx.args[7]);
      priorityFee = BigInt(parsedTx.args[8]);
      expectedRequester = getAddress(tx.from);
      break;
    case "createRequestWithETH":
      proposalURI = String(parsedTx.args[1]);
      proposalHash = String(parsedTx.args[2]);
      rubricHash = String(parsedTx.args[3]);
      domainMask = BigInt(parsedTx.args[4]);
      tier = Number(parsedTx.args[5]);
      priorityFee = BigInt(parsedTx.args[6]);
      expectedRequester = getAddress(tx.from);
      break;
    default:
      return { ok: false as const, code: 400, error: "unsupported_payment_router_call" };
  }

  if (proposalHash.toLowerCase() !== input.textHash.toLowerCase()) {
    return { ok: false as const, code: 400, error: "proposal_hash_mismatch", onchainProposalHash: proposalHash };
  }

  const paidEvents = receipt.logs.flatMap((log) => {
    if (getAddress(log.address) !== paymentRouterAddress) return [];
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      return parsed?.name === "RequestPaid" ? [parsed] : [];
    } catch (_err) {
      return [];
    }
  });
  const paid = paidEvents.find((event) => String(event.args.requestId) === input.requestId);
  if (!paid) return { ok: false as const, code: 400, error: "request_paid_event_not_found" };

  const txRequester = getAddress(tx.from);
  const eventRequester = getAddress(String(paid.args.requester));
  if (eventRequester !== expectedRequester) {
    return { ok: false as const, code: 400, error: "requester_event_mismatch" };
  }
  if (input.requester && getAddress(input.requester) !== expectedRequester) {
    return { ok: false as const, code: 403, error: "requester_mismatch" };
  }

  const handles = loadContracts(deployment, provider);
  const lifecycle = await handles.core.getRequestLifecycle(BigInt(input.requestId));
  const lifecycleRequester = getAddress(String(lifecycle[0]));
  if (lifecycleRequester !== expectedRequester) {
    return { ok: false as const, code: 400, error: "request_lifecycle_requester_mismatch" };
  }

  return {
    ok: true as const,
    requestId: input.requestId,
    requester: expectedRequester,
    relayer: txRequester === expectedRequester ? undefined : txRequester,
    proposalURI,
    proposalHash,
    rubricHash,
    domainMask: domainMask.toString(),
    tier,
      tierName: Tier[tier] ?? `Tier${tier}`,
    priorityFee: priorityFee.toString(),
    txHash: input.txHash,
    paymentFunction: parsedTx.name,
    paymentToken: String(paid.args.paymentToken),
    amountPaid: String(paid.args.amountPaid),
    blockNumber: receipt.blockNumber,
    status: Number(lifecycle[1]) as RequestStatus,
    statusName: RequestStatus[Number(lifecycle[1])] ?? `Status${Number(lifecycle[1])}`,
  };
}

export function buildServer(opts: ServerOptions): { app: FastifyInstance; db: ContentDB } {
  const db = new ContentDB(opts.dbPath);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
  const deploymentPath = opts.chain?.deploymentPath ?? "./.deployments/local.json";
  const rpcUrl = opts.chain?.rpcUrl;
  const rpcUrls = opts.chain?.rpcUrls;
  const requireAgentSignatures = opts.requireAgentSignatures ?? true;
  let relayerProvider: Provider | undefined;
  let relayerSigner: NonceManager | undefined;

  function chainProvider(): Provider {
    const deployment = loadDeploymentSnapshot(deploymentPath);
    const urls = parseRpcUrls(rpcUrl ?? deployment.rpcUrl, rpcUrls);
    relayerProvider ??= makeRpcProvider(urls, rpcFailoverOptionsFromEnv());
    return relayerProvider;
  }

  function relayer(): NonceManager {
    const key = opts.relayer?.privateKey;
    if (!key) throw new Error("content relayer private key not configured");
    const provider = chainProvider();
    relayerSigner ??= new NonceManager(new Wallet(key, provider));
    return relayerSigner;
  }

  async function buildUSDAIORequestIntent(body: z.infer<typeof RequestIntentBody>) {
    const normalized = normalizeRequestIntentFields({
      ...body,
      deadline: body.deadline ?? String(Math.floor(Date.now() / 1000) + 3600),
    });
    if (!normalized.ok) return normalized;

    const deployment = loadDeploymentSnapshot(deploymentPath);
    const provider = chainProvider();
    const handles = loadContracts(deployment, provider);
    const nonce = (await handles.paymentRouter.nonces(normalized.requester)) as bigint;
    const network = await provider.getNetwork();
    const domain = {
      name: "DAIOPaymentRouter",
      version: "1",
      chainId: Number(network.chainId),
      verifyingContract: getAddress(deployment.contracts.paymentRouter),
    };
    const message = {
      requester: normalized.requester,
      proposalURIHash: normalized.proposalURIHash,
      proposalHash: normalized.proposalHash,
      rubricHash: normalized.rubricHash,
      domainMask: normalized.domainMask,
      tier: normalized.tier,
      priorityFee: normalized.priorityFee,
      nonce: nonce.toString(),
      deadline: normalized.deadline!,
    };
    return {
      ok: true as const,
      requester: normalized.requester,
      id: normalized.id,
      proposalURI: normalized.proposalURI,
      proposalURIHash: normalized.proposalURIHash,
      proposalHash: normalized.proposalHash,
      rubricHash: normalized.rubricHash,
      domainMask: normalized.domainMask,
      tier: normalized.tier,
      tierName: Tier[normalized.tier] ?? `Tier${normalized.tier}`,
      priorityFee: normalized.priorityFee,
      nonce: nonce.toString(),
      deadline: normalized.deadline!,
      typedData: {
        domain,
        primaryType: "RequestIntent",
        types: REQUEST_INTENT_TYPES,
        message,
      },
    };
  }

  async function relayUSDAIORequest(body: z.infer<typeof RelayedDocumentBody>) {
    const intent = await buildUSDAIORequestIntent(body);
    if (!intent.ok) return intent;

    const deployment = loadDeploymentSnapshot(deploymentPath);
    const signer = relayer();
    const signerAddress = getAddress(await signer.getAddress());
    const handles = loadContracts(deployment, signer);
    const send = async () =>
      handles.paymentRouter.createRequestWithUSDAIOBySig(
        intent.requester,
        intent.proposalURI,
        intent.proposalHash,
        intent.rubricHash,
        intent.domainMask,
        intent.tier,
        intent.priorityFee,
        intent.deadline,
        body.signature,
      );
    let tx;
    try {
      tx = await send();
    } catch (err) {
      if (!isNonceError(err)) throw err;
      signer.reset();
      tx = await send();
    }
    const receipt = await tx.wait(opts.relayer?.confirmations ?? 1);
    if (!receipt || receipt.status !== 1) throw new Error(`relayed request transaction failed: ${tx.hash}`);

    const iface = new Interface(Artifacts.PaymentRouter().abi as never[]);
    const paymentRouterAddress = getAddress(deployment.contracts.paymentRouter);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paidEvents: any[] = receipt.logs.flatMap((log: { address: string; topics: readonly string[]; data: string }) => {
      if (getAddress(log.address) !== paymentRouterAddress) return [];
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        return parsed?.name === "RequestPaid" ? [parsed] : [];
      } catch (_err) {
        return [];
      }
    });
    const paid = paidEvents.find((event) => getAddress(String(event.args.requester)) === intent.requester);
    if (!paid) throw new Error("relayed request paid event not found");
    return {
      ok: true as const,
      relayer: signerAddress,
      txHash: receipt.hash,
      requestId: String(paid.args.requestId),
      blockNumber: receipt.blockNumber,
      intent,
    };
  }

  app.get("/health", async () => ({ ok: true }));

  app.post("/request-intents/usdaio", async (req, reply) => {
    const parsed = RequestIntentBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_request_intent", issues: parsed.error.issues };
    }
    try {
      const intent = await buildUSDAIORequestIntent(parsed.data);
      if (!intent.ok) {
        reply.code(400);
        return intent;
      }
      return intent;
    } catch (err) {
      reply.code(503);
      return { error: "chain_intent_unavailable", detail: formatError(err) };
    }
  });

  app.post("/requests/relayed-document", async (req, reply) => {
    const parsed = RelayedDocumentBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_relayed_document", issues: parsed.error.issues };
    }
    const body = parsed.data;
    const normalized = normalizeRequestIntentFields(body);
    if (!normalized.ok) {
      reply.code(400);
      return normalized;
    }

    let relayed: Awaited<ReturnType<typeof relayUSDAIORequest>>;
    try {
      relayed = await relayUSDAIORequest(body);
    } catch (err) {
      reply.code(502);
      return { error: "relayed_request_failed", detail: formatError(err) };
    }
    if (!relayed.ok) {
      reply.code(400);
      return relayed;
    }

    let verified: Awaited<ReturnType<typeof verifyRequestTransaction>>;
    try {
      verified = await verifyRequestTransaction({
        requestId: relayed.requestId,
        txHash: relayed.txHash,
        requester: normalized.requester,
        textHash: normalized.proposalHash,
        deploymentPath,
        rpcUrl,
        rpcUrls,
      });
    } catch (err) {
      reply.code(503);
      return { error: "chain_verification_unavailable", detail: formatError(err) };
    }
    if (!verified.ok) {
      reply.code(verified.code);
      return verified;
    }

    const idFromUri = proposalIdFromUri(verified.proposalURI);
    if (!idFromUri) {
      reply.code(400);
      return { error: "unsupported_proposal_uri", proposalURI: verified.proposalURI };
    }
    const mimeType = body.mimeType ?? "text/markdown";
    db.upsertProposal({ id: idFromUri, hash: normalized.proposalHash, mimeType, text: body.text });
    db.upsertRequestDocument({
      requestId: verified.requestId,
      requester: verified.requester,
      proposalUri: verified.proposalURI,
      proposalHash: verified.proposalHash,
      rubricHash: verified.rubricHash,
      domainMask: verified.domainMask,
      tier: verified.tier,
      priorityFee: verified.priorityFee,
      paymentTxHash: verified.txHash,
      paymentFunction: verified.paymentFunction,
      paymentToken: verified.paymentToken,
      amountPaid: verified.amountPaid,
      blockNumber: verified.blockNumber,
      status: verified.status,
      statusName: verified.statusName,
      proposalId: idFromUri,
    });
    return {
      relayed: {
        relayer: relayed.relayer,
        requestId: relayed.requestId,
        txHash: relayed.txHash,
        blockNumber: relayed.blockNumber,
      },
      document: serializeRequestDocument(db, relayed.requestId)!,
    };
  });

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
    const parsed = ReviewArtifactBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_artifact", issues: parsed.error.issues };
    }
    const artifact = "artifact" in parsed.data ? parsed.data.artifact : parsed.data;
    const signature = "signature" in parsed.data ? parsed.data.signature : undefined;
    const json = canonicalJson(artifact);
    const hash = canonicalHash(artifact);
    const sig = requireValidAgentSignature({
      enabled: requireAgentSignatures,
      signer: artifact.reviewer,
      message: agentArtifactMessage("review", hash),
      signature,
    });
    if (!sig.ok) {
      reply.code(sig.code);
      return { error: sig.error };
    }
    db.upsertBlob("reports", { hash, json });
    db.indexReviewArtifact({
      requestId: artifact.requestId,
      reviewerKey: addressKey(artifact.reviewer),
      reviewer: getAddress(artifact.reviewer),
      hash,
    });
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
    const parsed = AuditArtifactBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_artifact", issues: parsed.error.issues };
    }
    const artifact = "artifact" in parsed.data ? parsed.data.artifact : parsed.data;
    const signature = "signature" in parsed.data ? parsed.data.signature : undefined;
    const json = canonicalJson(artifact);
    const hash = canonicalHash(artifact);
    const sig = requireValidAgentSignature({
      enabled: requireAgentSignatures,
      signer: artifact.auditor,
      message: agentArtifactMessage("audit", hash),
      signature,
    });
    if (!sig.ok) {
      reply.code(sig.code);
      return { error: sig.error };
    }
    db.upsertBlob("audits", { hash, json });
    db.indexAuditArtifact({
      requestId: artifact.requestId,
      auditorKey: addressKey(artifact.auditor),
      auditor: getAddress(artifact.auditor),
      hash,
    });
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

  app.post<{ Params: { requestId: string } }>("/requests/:requestId/document", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId)) {
      reply.code(400);
      return { error: "invalid_request_id" };
    }
    const parsed = SubmitDocumentBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_document_submission", issues: parsed.error.issues };
    }

    const body = parsed.data;
    const hash = keccak256(toUtf8Bytes(body.text));
    let verified: Awaited<ReturnType<typeof verifyRequestTransaction>>;
    try {
      verified = await verifyRequestTransaction({
        requestId: req.params.requestId,
        txHash: body.txHash,
        requester: body.requester,
        textHash: hash,
        deploymentPath,
        rpcUrl,
        rpcUrls,
      });
    } catch (err) {
      reply.code(503);
      return { error: "chain_verification_unavailable", detail: (err as Error).message };
    }
    if (!verified.ok) {
      reply.code(verified.code);
      return verified;
    }

    const idFromUri = proposalIdFromUri(verified.proposalURI);
    if (!idFromUri) {
      reply.code(400);
      return { error: "unsupported_proposal_uri", proposalURI: verified.proposalURI };
    }
    if (body.id && body.id !== idFromUri) {
      reply.code(400);
      return { error: "proposal_id_mismatch", expected: idFromUri, got: body.id };
    }

    const mimeType = body.mimeType ?? "text/markdown";
    db.upsertProposal({ id: idFromUri, hash, mimeType, text: body.text });
    db.upsertRequestDocument({
      requestId: verified.requestId,
      requester: verified.requester,
      proposalUri: verified.proposalURI,
      proposalHash: verified.proposalHash,
      rubricHash: verified.rubricHash,
      domainMask: verified.domainMask,
      tier: verified.tier,
      priorityFee: verified.priorityFee,
      paymentTxHash: verified.txHash,
      paymentFunction: verified.paymentFunction,
      paymentToken: verified.paymentToken,
      amountPaid: verified.amountPaid,
      blockNumber: verified.blockNumber,
      status: verified.status,
      statusName: verified.statusName,
      proposalId: idFromUri,
    });
    return serializeRequestDocument(db, req.params.requestId)!;
  });

  app.get<{ Params: { requestId: string } }>("/requests/:requestId/document", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId)) {
      reply.code(400);
      return { error: "invalid_request_id" };
    }
    const doc = serializeRequestDocument(db, req.params.requestId);
    if (!doc) {
      reply.code(404);
      return { error: "not_found" };
    }
    return doc;
  });

  app.put("/agent-status", async (req, reply) => {
    const parsed = AgentStatusBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "invalid_agent_status", issues: parsed.error.issues };
    }
    const body = parsed.data;
    const agent = getAddress(body.agent);
    const sig = requireValidAgentSignature({
      enabled: requireAgentSignatures,
      signer: agent,
      message: agentStatusMessage({
        requestId: body.requestId,
        agent,
        phase: body.phase,
        status: body.status,
        detail: body.detail,
        payload: body.payload,
      }),
      signature: body.signature,
    });
    if (!sig.ok) {
      reply.code(sig.code);
      return { error: sig.error };
    }
    db.upsertAgentStatus({
      requestId: body.requestId,
      agentKey: addressKey(agent),
      agent,
      phase: body.phase,
      status: body.status,
      detail: body.detail,
      payloadJson: JSON.stringify(body.payload),
    });
    return serializeAgentStatus(db.getAgentStatus(body.requestId, addressKey(agent)));
  });

  app.get<{ Params: { requestId: string; agent: string } }>("/requests/:requestId/agents/:agent/status", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId) || !HexAddress.safeParse(req.params.agent).success) {
      reply.code(400);
      return { error: "invalid_params" };
    }
    const row = db.getAgentStatus(req.params.requestId, addressKey(req.params.agent));
    if (!row) {
      reply.code(404);
      return { error: "not_found" };
    }
    return serializeAgentStatus(row);
  });

  app.get<{ Params: { requestId: string } }>("/requests/:requestId/agent-statuses", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId)) {
      reply.code(400);
      return { error: "invalid_request_id" };
    }
    return {
      requestId: req.params.requestId,
      agents: db.listAgentStatuses(req.params.requestId).map((row) => serializeAgentStatus(row)),
    };
  });

  app.get<{ Params: { requestId: string; agent: string } }>("/requests/:requestId/agents/:agent/reasons", async (req, reply) => {
    if (!/^\d+$/.test(req.params.requestId) || !HexAddress.safeParse(req.params.agent).success) {
      reply.code(400);
      return { error: "invalid_params" };
    }
    const agent = getAddress(req.params.agent);
    const reviewRow = findReviewArtifact(db, req.params.requestId, agent);
    const auditRow = findAuditArtifact(db, req.params.requestId, agent);
    const reviewArtifact = reviewRow ? ReviewArtifact.parse(JSON.parse(reviewRow.json)) : undefined;
    const auditArtifact = auditRow ? AuditArtifact.parse(JSON.parse(auditRow.json)) : undefined;

    return {
      requestId: req.params.requestId,
      agent,
      rawThinking: RAW_THINKING_NOTICE,
      review: reviewArtifact
        ? {
            reportHash: reviewRow!.hash,
            proposalScore: reviewArtifact.proposalScore,
            summary: reviewArtifact.report.summary,
            recommendation: reviewArtifact.report.recommendation,
            confidence: reviewArtifact.report.confidence,
            rubricAssessments: reviewArtifact.report.rubricAssessments,
            strengths: reviewArtifact.report.strengths,
            weaknesses: reviewArtifact.report.weaknesses,
            risks: reviewArtifact.report.risks,
            rawFinalArtifact: reviewArtifact,
          }
        : null,
      audit: auditArtifact
        ? {
            auditHash: auditRow!.hash,
            targetEvaluations: auditArtifact.targets.map((targetReviewer, i) => ({
              targetReviewer,
              score: auditArtifact.scores[i],
              rationale: auditArtifact.rationales[i] ?? "",
            })),
            rawFinalArtifact: auditArtifact,
          }
        : null,
    };
  });

  return { app, db };
}
