import crypto from "node:crypto";
import { getAddress, keccak256, toUtf8Bytes, type ContractRunner, type Wallet } from "ethers";
import { ContentServiceClient, type RequestDocumentRecord } from "../../shared/content-client.js";
import type { ContractHandles } from "../chain/contracts.js";
import type { CoreEventStream } from "../chain/events.js";
import { REVIEW_SORTITION, RequestStatus } from "../../shared/types.js";
import { readReviewerMetadata } from "../chain/reviewerMetadata.js";
import { sortitionPass } from "../chain/sortition.js";
import { buildReviewMessages } from "../llm/prompts.js";
import { chat, extractJson } from "../llm/client.js";
import { parseReview } from "../llm/validate.js";
import type { ReviewArtifact } from "../../shared/schemas.js";
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

export interface ReviewFlowDeps {
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

async function hasReviewCommitWindow(
  deps: ReviewFlowDeps,
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
      `review: too late for commit request ${requestId}; remaining=${result.timing.remainingMs}ms min=${options.minCommitTimeRemainingMs}ms timeout=${result.timing.timeoutMs}ms elapsed=${result.timing.elapsedMs}ms`,
    );
    return false;
  } catch (err) {
    deps.log(`review: commit window check failed for request ${requestId}: ${(err as Error).message}`);
    return true;
  }
}

export async function runReview(
  deps: ReviewFlowDeps,
  requestId: bigint,
  finalityFactor: bigint,
  reviewElectionDifficulty: bigint,
  options: PhaseWorkOptions = {},
): Promise<{ committed: boolean; reason?: string; commitTx?: string; reportHash?: string; reportURI?: string }> {
  const { handles, events, content, state, wallet, vrf, log } = deps;
  const startBlock = events.phaseStartBlock(requestId, RequestStatus.ReviewCommit);
  if (startBlock === undefined) {
    return { committed: false, reason: "no review phase start block" };
  }

  const existing = state.load(requestId.toString());
  if (existing?.review?.commitTx && existing.review.accepted !== false) {
    return {
      committed: true,
      reason: "already_committed",
      commitTx: existing.review.commitTx,
      reportHash: existing.review.reportHash,
      reportURI: existing.review.reportURI,
    };
  }
  if (existing?.review?.accepted === false) {
    return { committed: false, reason: existing.review.notAcceptedReason ?? "not accepted" };
  }

  let document: RequestDocumentRecord;
  try {
    document = await waitForRequestDocument(content, requestId, {
      waitMs: options.documentWaitMs,
      log,
      onWaiting: (info) =>
        deps.recordStatus?.(requestId, "ReviewCommit", "waiting_document", "request document not registered yet", {
          elapsedMs: info.elapsedMs,
          nextRetryMs: info.nextRetryMs,
          waitMs: options.documentWaitMs,
        }) ?? Promise.resolve(),
      shouldContinue: async () => {
        try {
          const lifecycle = await handles.core.getRequestLifecycle(requestId);
          return Number(lifecycle[1] as bigint | number) === RequestStatus.ReviewCommit;
        } catch (err) {
          log(`review: document wait status check failed for request ${requestId}: ${(err as Error).message}`);
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
  const domainMask = BigInt(document.verified.domainMask);
  const tierName = document.verified.tierName;

  const eligible = (await handles.reviewerRegistry.isEligible(wallet.address, domainMask)) as boolean;
  if (!eligible) return { committed: false, reason: "not eligible" };

  const lifecycle = await handles.core.getRequestLifecycle(requestId);
  const committeeEpoch = BigInt(lifecycle[5] as bigint | number);
  const attempt = BigInt(lifecycle[4] as bigint | number);
  const existingParticipants = (await handles.commitReveal.getReviewParticipants(requestId, attempt)) as readonly string[];
  if (existingParticipants.some((addr) => getAddress(addr) === getAddress(wallet.address))) {
    return { committed: false, reason: "already_committed_onchain" };
  }
  const coreAddress = await handles.core.getAddress();
  const proof = await vrf.proofFor({
    coreAddress,
    requestId,
    phase: REVIEW_SORTITION,
    epoch: committeeEpoch,
    participant: wallet.address,
    phaseStartBlock: BigInt(startBlock),
    finalityFactor,
  });

  const passed = await sortitionPass({
    vrfCoordinator: handles.vrfCoordinator,
    coreAddress,
    publicKey: vrf.publicKey,
    proof,
    requestId,
    phase: REVIEW_SORTITION,
    epoch: committeeEpoch,
    participant: wallet.address,
    phaseStartBlock: BigInt(startBlock),
    finalityFactor,
    difficulty: reviewElectionDifficulty,
  });
  if (!passed) {
    log(`review: sortition NOT passed for request ${requestId}, skip`);
    return { committed: false, reason: "sortition_fail" };
  }
  if (!(await hasReviewCommitWindow(deps, requestId, startBlock, options))) {
    return { committed: false, reason: "too_late_for_commit" };
  }
  log(`review: sortition passed; running review for request ${requestId}`);

  const proposal = document.proposal;

  const computedHash = keccak256(toUtf8Bytes(proposal.text));
  if (computedHash.toLowerCase() !== proposal.hash.toLowerCase()) {
    throw new Error(`proposal hash mismatch: stored=${proposal.hash} computed=${computedHash}`);
  }
  if (computedHash.toLowerCase() !== document.verified.proposalHash.toLowerCase()) {
    throw new Error(`proposal hash mismatch: onchain=${document.verified.proposalHash} computed=${computedHash}`);
  }

  const reviewerMetadata = await readReviewerMetadata(handles, wallet.address);

  const messages = buildReviewMessages({
    schema: "daio.llm.input.v1",
    task: "review",
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
      status: "ReviewCommit",
    },
    reviewer: {
      wallet: wallet.address,
      ensName: reviewerMetadata.ensName,
      agentId: reviewerMetadata.agentId.toString(),
      domainMask: domainMask.toString(),
    },
    content: {
      proposal: { uri: proposal.uri, mimeType: proposal.mimeType, text: proposal.text },
      rubric: {
        hash: document.verified.rubricHash,
        text: "Evaluate clarity, novelty, technical correctness, evaluation quality, and presentation.",
      },
    },
    constraints: { scoreScale: 10000, outputLanguage: "en", maxReportBytes: 200000 },
  });

  const t0 = Date.now();
  const llm = await chat(messages, { responseFormatJson: true });
  const llmLatencyMs = Date.now() - t0;
  log(`review: LLM ok (${llmLatencyMs}ms, ${llm.totalTokens ?? "?"} tokens)`);
  const parsed = parseReview(extractJson(llm.content), {
    requestId: requestId.toString(),
    reviewer: wallet.address,
  });

  const artifact: ReviewArtifact = {
    schema: "daio.review.artifact.v1",
    requestId: parsed.requestId,
    reviewer: parsed.reviewer,
    proposalScore: parsed.proposalScore,
    report: parsed.report,
    source: {
      proposalURI: proposal.uri,
      proposalHash: proposal.hash,
      rubricHash: document.verified.rubricHash,
    },
    metadata: { model: parsed.metadata?.model, createdAt: new Date().toISOString() },
  };
  const reportHash = canonicalHash(artifact);
  const artifactSignature = await wallet.signMessage(agentArtifactMessage("review", reportHash));
  const stored = await content.putReport(artifact, artifactSignature);
  if (stored.hash !== reportHash) {
    throw new Error(`report hash mismatch between client (${reportHash}) and server (${stored.hash})`);
  }
  await deps.recordStatus?.(requestId, "ReviewCommit", "llm_completed", "review reasoning summary generated", {
    proposalScore: parsed.proposalScore,
    recommendation: parsed.report.recommendation,
    confidence: parsed.report.confidence,
    reportHash,
    reportURI: stored.uri,
    summary: parsed.report.summary,
    promptTokens: llm.promptTokens,
    completionTokens: llm.completionTokens,
    totalTokens: llm.totalTokens,
    llmLatencyMs,
  });
  if (!(await hasReviewCommitWindow(deps, requestId, startBlock, options))) {
    return { committed: false, reason: "too_late_for_commit", reportHash, reportURI: stored.uri };
  }

  const seed = `0x${crypto.randomBytes(32).toString("hex")}`;
  const seedBigInt = BigInt(seed);
  const resultHash = (await handles.commitReveal.hashReviewReveal(
    requestId,
    wallet.address,
    parsed.proposalScore,
    reportHash,
    stored.uri,
  )) as string;

  const stillEligible = (await handles.reviewerRegistry.isEligible(wallet.address, domainMask)) as boolean;
  if (!stillEligible) {
    return { committed: false, reason: "not eligible at commit time", reportHash, reportURI: stored.uri };
  }

  state.save({
    requestId: requestId.toString(),
    reviewer: wallet.address,
    phase: "ReviewCommit",
    review: {
      proposalScore: parsed.proposalScore,
      reportHash,
      reportURI: stored.uri,
      resultHash,
      seed: state.encryptSeed(seed),
    },
  });

  const cr = handles.commitReveal.connect(deps.txSigner);
  const commitArgs = [requestId, resultHash, seedBigInt, proof] as const;
  const gasLimit = await gasLimitWithHeadroom(
    cr.commitReview,
    commitArgs,
    "DAIO_REVIEW_COMMIT_GAS_FLOOR",
    1_000_000n,
  );
  const receipt = await deps.txQueue(async () => {
    const tx = await cr.commitReview(...commitArgs, { gasLimit });
    return waitForTransactionWithRetries(tx);
  });
  if (!receipt || receipt.status !== 1) {
    throw new Error(`review commit transaction failed: ${receipt?.hash ?? "unknown tx"}`);
  }

  const participants = (await handles.commitReveal.getReviewParticipants(requestId, attempt)) as readonly string[];
  const accepted = participants.some((addr) => getAddress(addr) === getAddress(wallet.address));

  const cur = state.load(requestId.toString())!;
  cur.review!.commitTx = receipt.hash;
  cur.review!.accepted = accepted;
  if (!accepted) {
    cur.review!.notAcceptedReason = "late_not_accepted";
    state.save(cur);
    log(`review: commit tx succeeded but was not accepted (tx=${receipt.hash})`);
    return {
      committed: false,
      reason: "late_not_accepted",
      commitTx: receipt.hash,
      reportHash,
      reportURI: stored.uri,
    };
  }
  state.save(cur);
  log(`review: committed (tx=${receipt.hash})`);

  return { committed: true, commitTx: receipt.hash, reportHash, reportURI: stored.uri };
}

export async function runReviewReveal(
  deps: ReviewFlowDeps,
  requestId: bigint,
): Promise<{ revealed: boolean; reason?: string; revealTx?: string }> {
  const { handles, state, wallet, log } = deps;
  const cur = state.load(requestId.toString());
  if (!cur || !cur.review) return { revealed: false, reason: "no review state" };
  if (cur.review.accepted === false) return { revealed: false, reason: cur.review.notAcceptedReason ?? "not accepted" };
  if (cur.review.revealTx) return { revealed: false, reason: "already revealed" };

  const seed = state.decryptSeed(cur.review.seed);
  const cr = handles.commitReveal.connect(deps.txSigner);
  const args = [
    requestId,
    cur.review.proposalScore,
    cur.review.reportHash,
    cur.review.reportURI,
    BigInt(seed),
  ] as const;
  const gasLimit = await gasLimitWithHeadroom(cr.revealReview, args, "DAIO_REVIEW_REVEAL_GAS_FLOOR", 2_000_000n);
  const receipt = await deps.txQueue(async () => {
    const tx = await cr.revealReview(
      ...args,
      { gasLimit },
    );
    return waitForTransactionWithRetries(tx);
  });
  if (!receipt || receipt.status !== 1) {
    throw new Error(`review reveal transaction failed: ${receipt?.hash ?? "unknown tx"}`);
  }
  log(`review: revealed (tx=${receipt.hash})`);
  cur.review.revealTx = receipt.hash;
  cur.phase = "ReviewReveal";
  state.save(cur);
  return { revealed: true, revealTx: receipt.hash };
}
