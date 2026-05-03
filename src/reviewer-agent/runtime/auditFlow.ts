import crypto from "node:crypto";
import { getAddress, keccak256, toUtf8Bytes, type ContractRunner, type Wallet } from "ethers";
import { ContentServiceClient, type RequestDocumentRecord } from "../../shared/content-client.js";
import type { ContractHandles } from "../chain/contracts.js";
import type { CoreEventStream } from "../chain/events.js";
import { AUDIT_SORTITION, RequestStatus, SCALE } from "../../shared/types.js";
import { buildAuditMessages } from "../llm/prompts.js";
import { chat, extractJson } from "../llm/client.js";
import { parseAudit } from "../llm/validate.js";
import type { AuditArtifact } from "../../shared/schemas.js";
import { canonicalHash } from "../../shared/canonical.js";
import { agentArtifactMessage } from "../../shared/agent-signing.js";
import type { StateStore } from "./state.js";
import { gasLimitWithHeadroom } from "./gas.js";
import type { VrfProofProvider } from "../chain/vrfProof.js";
import {
  RequestDocumentUnavailableError,
  RequestDocumentWaitAbortedError,
  waitForRequestDocument,
} from "./document.js";
import { waitForTransactionWithRetries } from "../../shared/rpc.js";
import { phaseHasMinimumRemaining } from "./phaseTiming.js";

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
  recordStatus?: (
    requestId: bigint,
    phase: string,
    status: string,
    detail?: string,
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}

export interface PhaseWorkOptions {
  documentWaitMs?: number;
  phaseTimeoutMs?: number;
  minCommitTimeRemainingMs?: number;
}

async function hasAuditCommitWindow(
  deps: AuditFlowDeps,
  requestId: bigint,
  startBlock: number,
  options: PhaseWorkOptions,
): Promise<boolean> {
  if (!deps.wallet.provider) return true;
  try {
    const result = await phaseHasMinimumRemaining(
      deps.wallet.provider,
      startBlock,
      options.phaseTimeoutMs,
      options.minCommitTimeRemainingMs,
    );
    if (result.ok) return true;
    deps.log(
      `audit: too late for commit request ${requestId}; remaining=${result.timing.remainingMs}ms min=${options.minCommitTimeRemainingMs}ms timeout=${result.timing.timeoutMs}ms elapsed=${result.timing.elapsedMs}ms`,
    );
    return false;
  } catch (err) {
    deps.log(`audit: commit window check failed for request ${requestId}: ${(err as Error).message}`);
    return true;
  }
}

export async function runAudit(
  deps: AuditFlowDeps,
  requestId: bigint,
  finalityFactor: bigint,
  auditElectionDifficulty: bigint,
  auditTargetLimit: bigint,
  options: PhaseWorkOptions = {},
): Promise<{ committed: boolean; reason?: string; commitTx?: string; auditHash?: string; auditURI?: string }> {
  const { handles, events, content, state, wallet, vrf, log } = deps;

  const startBlock = events.phaseStartBlock(requestId, RequestStatus.AuditCommit);
  if (startBlock === undefined) return { committed: false, reason: "no audit phase start block" };

  const existing = state.load(requestId.toString());
  if (existing?.audit?.commitTx && existing.audit.accepted !== false) {
    return {
      committed: true,
      reason: "already_committed",
      commitTx: existing.audit.commitTx,
      auditHash: existing.audit.auditHash,
      auditURI: existing.audit.auditURI,
    };
  }
  if (existing?.audit?.accepted === false) {
    return { committed: false, reason: existing.audit.notAcceptedReason ?? "not accepted" };
  }

  const revealedReviewers = events.revealedReviewersOrdered(requestId);
  const selfRevealed = revealedReviewers.find((r) => getAddress(r.reviewer) === getAddress(wallet.address));
  if (!selfRevealed) return { committed: false, reason: "self did not reveal" };

  const reviewers = revealedReviewers.map((r) => getAddress(r.reviewer));
  const candidateTargets = reviewers.filter((r) => r !== getAddress(wallet.address));
  if (candidateTargets.length === 0) return { committed: false, reason: "no candidate targets" };

  const lifecycle = await handles.core.getRequestLifecycle(requestId);
  const attempt = BigInt(lifecycle[4] as bigint | number);
  const auditEpoch = BigInt(lifecycle[6] as bigint | number);
  const existingParticipants = (await handles.commitReveal.getAuditParticipants(requestId, attempt)) as readonly string[];
  if (existingParticipants.some((addr) => getAddress(addr) === getAddress(wallet.address))) {
    return { committed: false, reason: "already_committed_onchain" };
  }
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

  const vrfCoordinatorAddress = await handles.vrfCoordinator.getAddress();
  const verifyTargets = (proofs: typeof targetProofs) =>
    handles.assignmentManager.verifiedCanonicalAuditTargets(
      vrfCoordinatorAddress,
      vrf.publicKey,
      coreAddress,
      requestId,
      wallet.address,
      reviewers,
      proofs,
      auditEpoch,
      startBlockBigInt,
      finalityFactor,
      auditElectionDifficulty,
      auditTargetLimit,
    ) as Promise<readonly [boolean, readonly string[]]>;

  let commitTargetProofs = targetProofs;
  let verified: readonly [boolean, readonly string[]];
  if (auditElectionDifficulty >= SCALE) {
    const fullSortition = await verifyTargets([]);
    if (fullSortition[0] && fullSortition[1].length > 0) {
      verified = fullSortition;
      commitTargetProofs = [];
      log("audit: full-sortition path detected; committing without target VRF proofs");
    } else {
      verified = await verifyTargets(targetProofs);
      log("audit: deployed assignment manager requires target VRF proofs for full-sortition config");
    }
  } else {
    verified = await verifyTargets(targetProofs);
  }
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

  let document: RequestDocumentRecord;
  try {
    document = await waitForRequestDocument(content, requestId, {
      waitMs: options.documentWaitMs,
      log,
      onWaiting: (info) =>
        deps.recordStatus?.(requestId, "AuditCommit", "waiting_document", "request document not registered yet", {
          elapsedMs: info.elapsedMs,
          nextRetryMs: info.nextRetryMs,
          waitMs: options.documentWaitMs,
        }) ?? Promise.resolve(),
      shouldContinue: async () => {
        try {
          const lifecycle = await handles.core.getRequestLifecycle(requestId);
          return Number(lifecycle[1] as bigint | number) === RequestStatus.AuditCommit;
        } catch (err) {
          log(`audit: document wait status check failed for request ${requestId}: ${(err as Error).message}`);
          return true;
        }
      },
    });
  } catch (err) {
    if (err instanceof RequestDocumentUnavailableError) {
      return { committed: false, reason: "document_unavailable" };
    }
    if (err instanceof RequestDocumentWaitAbortedError) {
      return { committed: false, reason: "document_wait_aborted" };
    }
    throw err;
  }
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

  if (!(await hasAuditCommitWindow(deps, requestId, startBlock, options))) {
    return { committed: false, reason: "too_late_for_commit" };
  }

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
  if (!(await hasAuditCommitWindow(deps, requestId, startBlock, options))) {
    return { committed: false, reason: "too_late_for_commit", auditHash, auditURI: stored.uri };
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
  const commitArgs = [requestId, resultHash, BigInt(seed), commitTargetProofs] as const;
  const gasLimit = await gasLimitWithHeadroom(
    cr.commitAudit,
    commitArgs,
    "DAIO_AUDIT_COMMIT_GAS_FLOOR",
    1_500_000n,
  );
  const receipt = await deps.txQueue(async () => {
    const tx = await cr.commitAudit(...commitArgs, { gasLimit });
    return waitForTransactionWithRetries(tx);
  });
  if (!receipt || receipt.status !== 1) {
    throw new Error(`audit commit transaction failed: ${receipt?.hash ?? "unknown tx"}`);
  }

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
    return waitForTransactionWithRetries(tx);
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
