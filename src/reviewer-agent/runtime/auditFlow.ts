import crypto from "node:crypto";
import { getAddress, keccak256, toUtf8Bytes, type Wallet } from "ethers";
import { ContentServiceClient } from "../../shared/content-client.js";
import type { ContractHandles } from "../chain/contracts.js";
import type { CoreEventStream } from "../chain/events.js";
import { RequestStatus, DOMAIN_RESEARCH } from "../../shared/types.js";
import { buildAuditMessages } from "../llm/prompts.js";
import { chat, extractJson } from "../llm/client.js";
import { parseAudit } from "../llm/validate.js";
import type { StateStore } from "./state.js";

export interface AuditFlowDeps {
  handles: ContractHandles;
  events: CoreEventStream;
  content: ContentServiceClient;
  state: StateStore;
  wallet: Wallet;
  publicKey: [bigint, bigint];
  proof: [bigint, bigint, bigint, bigint];
  log: (msg: string) => void;
}

export async function runAudit(
  deps: AuditFlowDeps,
  requestId: bigint,
  finalityFactor: bigint,
  auditElectionDifficulty: bigint,
  auditTargetLimit: bigint,
): Promise<{ committed: boolean; reason?: string }> {
  const { handles, events, content, state, wallet, publicKey, proof, log } = deps;

  const startBlock = events.phaseStartBlock(requestId, RequestStatus.AuditCommit);
  if (startBlock === undefined) return { committed: false, reason: "no audit phase start block" };

  const revealedReviewers = events.revealedReviewersOrdered(requestId);
  const selfRevealed = revealedReviewers.find((r) => getAddress(r.reviewer) === getAddress(wallet.address));
  if (!selfRevealed) return { committed: false, reason: "self did not reveal" };

  const reviewers = revealedReviewers.map((r) => getAddress(r.reviewer));
  const targetProofs = reviewers.filter((r) => r !== getAddress(wallet.address)).map(() => proof);
  if (targetProofs.length === 0) return { committed: false, reason: "no candidate targets" };

  const lifecycle = await handles.core.getRequestLifecycle(requestId);
  const auditEpoch = BigInt(lifecycle[6] as bigint | number);

  const verified = (await handles.assignmentManager.verifiedCanonicalAuditTargets(
    await handles.vrfCoordinator.getAddress(),
    publicKey,
    await handles.core.getAddress(),
    requestId,
    wallet.address,
    reviewers,
    targetProofs,
    auditEpoch,
    BigInt(startBlock),
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

  const proposalUri = "content://proposals/paper-001";
  const proposal = await content.resolveProposal(proposalUri);
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
      rubricHash: keccak256(toUtf8Bytes("paper-001:rubric")),
      domainMask: DOMAIN_RESEARCH.toString(),
      tier: "Fast",
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
        hash: keccak256(toUtf8Bytes("paper-001:rubric")),
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
    resultHash,
    seed: state.encryptSeed(seed),
  };
  state.save(cur);

  const cr = handles.commitReveal.connect(wallet);
  const tx = await cr.commitAudit(requestId, resultHash, BigInt(seed), targetProofs);
  const receipt = await tx.wait();
  log(`audit: committed (tx=${receipt?.hash})`);

  cur.audit.commitTx = receipt?.hash;
  state.save(cur);

  return { committed: true };
}

export async function runAuditReveal(
  deps: AuditFlowDeps,
  requestId: bigint,
): Promise<{ revealed: boolean; reason?: string }> {
  const { handles, state, wallet, log } = deps;
  const cur = state.load(requestId.toString());
  if (!cur || !cur.audit) return { revealed: false, reason: "no audit state" };
  if (cur.audit.revealTx) return { revealed: false, reason: "already revealed" };

  const seed = state.decryptSeed(cur.audit.seed);
  const cr = handles.commitReveal.connect(wallet);
  const tx = await cr.revealAudit(requestId, cur.audit.targets, cur.audit.scores, BigInt(seed));
  const receipt = await tx.wait();
  log(`audit: revealed (tx=${receipt?.hash})`);
  cur.audit.revealTx = receipt?.hash;
  cur.phase = "AuditReveal";
  state.save(cur);
  return { revealed: true };
}
