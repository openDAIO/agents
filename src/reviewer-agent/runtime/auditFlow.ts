import crypto from "node:crypto";
import { getAddress, keccak256, toUtf8Bytes, type ContractRunner, type Wallet } from "ethers";
import { ContentServiceClient } from "../../shared/content-client.js";
import type { ContractHandles } from "../chain/contracts.js";
import type { CoreEventStream } from "../chain/events.js";
import { AUDIT_SORTITION, RequestStatus } from "../../shared/types.js";
import { buildAuditMessages } from "../llm/prompts.js";
import { chat, extractJson } from "../llm/client.js";
import { parseAudit } from "../llm/validate.js";
import type { AuditArtifact } from "../../shared/schemas.js";
import { canonicalHash } from "../../shared/canonical.js";
import { agentArtifactMessage } from "../../shared/agent-signing.js";
import type { StateStore } from "./state.js";
import { gasLimitWithHeadroom } from "./gas.js";
import type { VrfProofProvider } from "../chain/vrfProof.js";

export interface AuditFlowDeps {
  handles: ContractHandles;
  events: CoreEventStream;
  content: ContentServiceClient;
  state: StateStore;
  wallet: Wallet;
  txSigner: ContractRunner;
  vrf: VrfProofProvider;
  log: (msg: string) => void;
  txQueue: <T>(task: () => Promise<T>) => Promise<T>;
}

export async function runAudit(
  deps: AuditFlowDeps,
  requestId: bigint,
  finalityFactor: bigint,
  auditElectionDifficulty: bigint,
  auditTargetLimit: bigint,
): Promise<{ committed: boolean; reason?: string; commitTx?: string; auditHash?: string; auditURI?: string }> {
  const { handles, events, content, state, wallet, vrf, log } = deps;

  const startBlock = events.phaseStartBlock(requestId, RequestStatus.AuditCommit);
  if (startBlock === undefined) return { committed: false, reason: "no audit phase start block" };

  const revealedReviewers = events.revealedReviewersOrdered(requestId);
  const selfRevealed = revealedReviewers.find((r) => getAddress(r.reviewer) === getAddress(wallet.address));
  if (!selfRevealed) return { committed: false, reason: "self did not reveal" };

  const reviewers = revealedReviewers.map((r) => getAddress(r.reviewer));
  const candidateTargets = reviewers.filter((r) => r !== getAddress(wallet.address));
  if (candidateTargets.length === 0) return { committed: false, reason: "no candidate targets" };

  const lifecycle = await handles.core.getRequestLifecycle(requestId);
  const auditEpoch = BigInt(lifecycle[6] as bigint | number);
  const startBlockBigInt = BigInt(startBlock);
  const coreAddress = await handles.core.getAddress();
  const targetProofs = await Promise.all(
    candidateTargets.map((target) =>
      vrf.proofFor({
        coreAddress,
        requestId,
        phase: AUDIT_SORTITION,
        epoch: auditEpoch,
        participant: wallet.address,
        target,
        phaseStartBlock: startBlockBigInt,
        finalityFactor,
      }),
    ),
  );
  if (targetProofs.length === 0) return { committed: false, reason: "no candidate targets" };

  const verified = (await handles.assignmentManager.verifiedCanonicalAuditTargets(
    await handles.vrfCoordinator.getAddress(),
    vrf.publicKey,
    coreAddress,
    requestId,
    wallet.address,
    reviewers,
    targetProofs,
    auditEpoch,
    startBlockBigInt,
    finalityFactor,
    auditElectionDifficulty,
    auditTargetLimit,
  )) as readonly [boolean, readonly string[]];
  const ok = verified[0];
  const selectedTargets = verified[1].map((a) => getAddress(a));
  if (!ok || selectedTargets.length === 0) {
    return { committed: false, reason: `no canonical targets (ok=${ok}, count=${selectedTargets.length})` };
  }
  log(`audit: canonical targets = [${selectedTargets.join(",")}]`);

  const targetReports = await Promise.all(
    selectedTargets.map(async (addr) => {
      const reveal = revealedReviewers.find((r) => getAddress(r.reviewer) === addr)!;
      const stored = await content.resolveReport(reveal.reportURI);
      if (stored.hash !== reveal.reportHash) {
        throw new Error(`audit: report hash mismatch for ${addr}`);
      }
      return {
        targetReviewer: addr,
        proposalScore: reveal.proposalScore,
        reportURI: reveal.reportURI,
        reportHash: reveal.reportHash,
        report: stored.artifact.report,
      };
    }),
  );

  const document = await content.getRequestDocument(requestId);
  const proposal = document.proposal;
  const computedHash = keccak256(toUtf8Bytes(proposal.text));
  if (computedHash.toLowerCase() !== proposal.hash.toLowerCase()) {
    throw new Error(`proposal hash mismatch: stored=${proposal.hash} computed=${computedHash}`);
  }
  if (computedHash.toLowerCase() !== document.verified.proposalHash.toLowerCase()) {
    throw new Error(`proposal hash mismatch: onchain=${document.verified.proposalHash} computed=${computedHash}`);
  }
  const domainMask = BigInt(document.verified.domainMask);
  const tierName = document.verified.tierName;

  const ensName = `reviewer-${wallet.address.slice(2, 8).toLowerCase()}.daio.eth`;
  const agentId = (await handles.reviewerRegistry.agentId(wallet.address)) as bigint;

  const messages = buildAuditMessages({
    schema: "daio.llm.input.v1",
    task: "audit",
    chain: {
      chainId: Number((await wallet.provider!.getNetwork()).chainId),
      core: await handles.core.getAddress(),
      commitRevealManager: await handles.commitReveal.getAddress(),
    },
    request: {
      requestId: requestId.toString(),
      proposalURI: proposal.uri,
      proposalHash: proposal.hash,
      rubricHash: document.verified.rubricHash,
      domainMask: domainMask.toString(),
      tier: tierName,
      status: "AuditCommit",
    },
    auditor: {
      wallet: wallet.address,
      ensName,
      agentId: agentId.toString(),
    },
    content: {
      proposal: { uri: proposal.uri, mimeType: proposal.mimeType, text: proposal.text },
      rubric: {
        hash: document.verified.rubricHash,
        text: "Evaluate clarity, novelty, technical correctness, evaluation quality, and presentation.",
      },
      targets: targetReports,
    },
    constraints: { scoreScale: 10000, targetOrder: "must_preserve_input_order" },
  });

  const t0 = Date.now();
  const llm = await chat(messages, { responseFormatJson: true });
  log(`audit: LLM ok (${Date.now() - t0}ms, ${llm.totalTokens ?? "?"} tokens)`);
  const parsed = parseAudit(extractJson(llm.content), {
    requestId: requestId.toString(),
    auditor: wallet.address,
    targets: selectedTargets,
  });

  const targetsArr = parsed.targetEvaluations.map((e) => getAddress(e.targetReviewer));
  const scoresArr = parsed.targetEvaluations.map((e) => e.score);
  const rationalesArr = parsed.targetEvaluations.map((e) => e.rationale);

  const artifact: AuditArtifact = {
    schema: "daio.audit.artifact.v1",
    requestId: parsed.requestId,
    auditor: parsed.auditor,
    targets: targetsArr,
    scores: scoresArr,
    rationales: rationalesArr,
    source: {
      proposalURI: proposal.uri,
      proposalHash: proposal.hash,
    },
    metadata: { model: parsed.metadata?.model, createdAt: new Date().toISOString() },
  };
  const auditHash = canonicalHash(artifact);
  const artifactSignature = await wallet.signMessage(agentArtifactMessage("audit", auditHash));
  const stored = await content.putAudit(artifact, artifactSignature);
  if (stored.hash !== auditHash) {
    throw new Error(`audit hash mismatch between client (${auditHash}) and server (${stored.hash})`);
  }

  const seed = `0x${crypto.randomBytes(32).toString("hex")}`;
  const resultHash = (await handles.commitReveal.hashAuditReveal(
    requestId,
    wallet.address,
    targetsArr,
    scoresArr,
  )) as string;

  const cur = state.load(requestId.toString()) ?? {
    requestId: requestId.toString(),
    reviewer: wallet.address,
    phase: "AuditCommit",
  };
  cur.audit = {
    targets: targetsArr,
    scores: scoresArr,
    rationales: rationalesArr,
    auditHash,
    auditURI: stored.uri,
    resultHash,
    seed: state.encryptSeed(seed),
  };
  state.save(cur);

  const cr = handles.commitReveal.connect(deps.txSigner);
  const commitArgs = [requestId, resultHash, BigInt(seed), targetProofs] as const;
  const gasLimit = await gasLimitWithHeadroom(
    cr.commitAudit,
    commitArgs,
    "DAIO_AUDIT_COMMIT_GAS_FLOOR",
    1_500_000n,
  );
  const receipt = await deps.txQueue(async () => {
    const tx = await cr.commitAudit(...commitArgs, { gasLimit });
    return tx.wait();
  });
  if (!receipt || receipt.status !== 1) {
    throw new Error(`audit commit transaction failed: ${receipt?.hash ?? "unknown tx"}`);
  }

  const attempt = BigInt((await handles.core.getRequestLifecycle(requestId))[4] as bigint | number);
  const participants = (await handles.commitReveal.getAuditParticipants(requestId, attempt)) as readonly string[];
  const accepted = participants.some((addr) => getAddress(addr) === getAddress(wallet.address));

  cur.audit.commitTx = receipt.hash;
  cur.audit.accepted = accepted;
  if (!accepted) {
    cur.audit.notAcceptedReason = "late_not_accepted";
    state.save(cur);
    log(`audit: commit tx succeeded but was not accepted (tx=${receipt.hash})`);
    return { committed: false, reason: "late_not_accepted", commitTx: receipt.hash, auditHash, auditURI: stored.uri };
  }
  state.save(cur);
  log(`audit: committed (tx=${receipt.hash})`);

  return { committed: true, commitTx: receipt.hash, auditHash, auditURI: stored.uri };
}

export async function runAuditReveal(
  deps: AuditFlowDeps,
  requestId: bigint,
): Promise<{ revealed: boolean; reason?: string; revealTx?: string }> {
  const { handles, state, wallet, log } = deps;
  const cur = state.load(requestId.toString());
  if (!cur || !cur.audit) return { revealed: false, reason: "no audit state" };
  if (cur.audit.accepted === false) return { revealed: false, reason: cur.audit.notAcceptedReason ?? "not accepted" };
  if (cur.audit.revealTx) return { revealed: false, reason: "already revealed" };

  const seed = state.decryptSeed(cur.audit.seed);
  const cr = handles.commitReveal.connect(deps.txSigner);
  const args = [requestId, cur.audit.targets, cur.audit.scores, BigInt(seed)] as const;
  const gasLimit = await gasLimitWithHeadroom(cr.revealAudit, args, "DAIO_AUDIT_REVEAL_GAS_FLOOR", 8_000_000n);
  const receipt = await deps.txQueue(async () => {
    const tx = await cr.revealAudit(...args, { gasLimit });
    return tx.wait();
  });
  if (!receipt || receipt.status !== 1) {
    throw new Error(`audit reveal transaction failed: ${receipt?.hash ?? "unknown tx"}`);
  }
  log(`audit: revealed (tx=${receipt.hash})`);
  cur.audit.revealTx = receipt.hash;
  cur.phase = "AuditReveal";
  state.save(cur);
  return { revealed: true, revealTx: receipt.hash };
}
