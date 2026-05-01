import crypto from "node:crypto";
import { keccak256, toUtf8Bytes, type Wallet } from "ethers";
import { ContentServiceClient } from "../../shared/content-client.js";
import type { ContractHandles } from "../chain/contracts.js";
import type { CoreEventStream } from "../chain/events.js";
import { sortitionPass } from "../chain/sortition.js";
import { REVIEW_SORTITION, RequestStatus, DOMAIN_RESEARCH } from "../../shared/types.js";
import { buildReviewMessages } from "../llm/prompts.js";
import { chat, extractJson } from "../llm/client.js";
import { parseReview } from "../llm/validate.js";
import type { ReviewArtifact } from "../../shared/schemas.js";
import { canonicalHash } from "../../shared/canonical.js";
import type { StateStore } from "./state.js";

export interface ReviewFlowDeps {
  handles: ContractHandles;
  events: CoreEventStream;
  content: ContentServiceClient;
  state: StateStore;
  wallet: Wallet;
  publicKey: [bigint, bigint];
  proof: [bigint, bigint, bigint, bigint];
  log: (msg: string) => void;
}

export async function runReview(
  deps: ReviewFlowDeps,
  requestId: bigint,
  finalityFactor: bigint,
  reviewElectionDifficulty: bigint,
): Promise<{ committed: boolean; reason?: string }> {
  const { handles, events, content, state, wallet, publicKey, proof, log } = deps;
  const startBlock = events.phaseStartBlock(requestId, RequestStatus.ReviewCommit);
  if (startBlock === undefined) {
    return { committed: false, reason: "no review phase start block" };
  }

  const eligible = (await handles.reviewerRegistry.isEligible(wallet.address, DOMAIN_RESEARCH)) as boolean;
  if (!eligible) return { committed: false, reason: "not eligible" };

  const lifecycle = await handles.core.getRequestLifecycle(requestId);
  const committeeEpoch = BigInt(lifecycle[5] as bigint | number);

  const passed = await sortitionPass({
    vrfCoordinator: handles.vrfCoordinator,
    coreAddress: await handles.core.getAddress(),
    publicKey,
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
  log(`review: sortition passed; running review for request ${requestId}`);

  const requestHandle = await handles.core.getRequestLifecycle(requestId);
  const requesterStr = String(requestHandle[0]);
  void requesterStr;
  const proposalUri = "content://proposals/paper-001";
  const proposal = await content.resolveProposal(proposalUri);

  const computedHash = keccak256(toUtf8Bytes(proposal.text));
  if (computedHash !== proposal.hash) {
    throw new Error(`proposal hash mismatch: stored=${proposal.hash} computed=${computedHash}`);
  }

  const ensName = `reviewer-${wallet.address.slice(2, 8).toLowerCase()}.daio.eth`;
  const agentId = (await handles.reviewerRegistry.agentId(wallet.address)) as bigint;

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
      rubricHash: keccak256(toUtf8Bytes("paper-001:rubric")),
      domainMask: DOMAIN_RESEARCH.toString(),
      tier: "Fast",
      status: "ReviewCommit",
    },
    reviewer: {
      wallet: wallet.address,
      ensName,
      agentId: agentId.toString(),
      domainMask: DOMAIN_RESEARCH.toString(),
    },
    content: {
      proposal: { uri: proposal.uri, mimeType: proposal.mimeType, text: proposal.text },
      rubric: {
        hash: keccak256(toUtf8Bytes("paper-001:rubric")),
        text: "Evaluate clarity, novelty, technical correctness, evaluation quality, and presentation.",
      },
    },
    constraints: { scoreScale: 10000, outputLanguage: "en", maxReportBytes: 200000 },
  });

  const t0 = Date.now();
  const llm = await chat(messages, { responseFormatJson: true });
  log(`review: LLM ok (${Date.now() - t0}ms, ${llm.totalTokens ?? "?"} tokens)`);
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
      rubricHash: keccak256(toUtf8Bytes("paper-001:rubric")),
    },
    metadata: { model: parsed.metadata?.model, createdAt: new Date().toISOString() },
  };
  const stored = await content.putReport(artifact);
  const reportHash = canonicalHash(artifact);
  if (stored.hash !== reportHash) {
    throw new Error(`report hash mismatch between client (${reportHash}) and server (${stored.hash})`);
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

  const cr = handles.commitReveal.connect(wallet);
  const tx = await cr.commitReview(requestId, resultHash, seedBigInt, proof);
  const receipt = await tx.wait();
  log(`review: committed (tx=${receipt?.hash})`);

  const cur = state.load(requestId.toString())!;
  cur.review!.commitTx = receipt?.hash;
  state.save(cur);

  return { committed: true };
}

export async function runReviewReveal(
  deps: ReviewFlowDeps,
  requestId: bigint,
): Promise<{ revealed: boolean; reason?: string }> {
  const { handles, state, wallet, log } = deps;
  const cur = state.load(requestId.toString());
  if (!cur || !cur.review) return { revealed: false, reason: "no review state" };
  if (cur.review.revealTx) return { revealed: false, reason: "already revealed" };

  const seed = state.decryptSeed(cur.review.seed);
  const cr = handles.commitReveal.connect(wallet);
  const tx = await cr.revealReview(
    requestId,
    cur.review.proposalScore,
    cur.review.reportHash,
    cur.review.reportURI,
    BigInt(seed),
  );
  const receipt = await tx.wait();
  log(`review: revealed (tx=${receipt?.hash})`);
  cur.review.revealTx = receipt?.hash;
  cur.phase = "ReviewReveal";
  state.save(cur);
  return { revealed: true };
}
