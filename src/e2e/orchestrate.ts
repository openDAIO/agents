import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, NonceManager, Wallet, id, keccak256, parseEther, toUtf8Bytes } from "ethers";
import { startHardhatNode, HARDHAT_PRIV_KEYS } from "./hardhat.js";
import { deployAll } from "./deploy.js";
import { loadContracts } from "../reviewer-agent/chain/contracts.js";
import { registerReviewerIfNeeded } from "../reviewer-agent/chain/registration.js";
import { preScreenCommittee } from "./sortition-prescreen.js";
import { ContentServiceClient } from "../shared/content-client.js";
import type { DeploymentSnapshot } from "../shared/types.js";
import { DOMAIN_RESEARCH, RequestStatus } from "../shared/types.js";
import { CoreEventStream } from "../reviewer-agent/chain/events.js";
import { makeSecp256k1VrfProvider } from "../reviewer-agent/chain/vrfProof.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");

const FAST = 0;
const E2E_AGENT_COUNT = 5;
const E2E_QUORUM = 3;
const E2E_REVIEW_VRF_DIFFICULTY = 8000n;
const E2E_AUDIT_VRF_DIFFICULTY = 10000n;
const E2E_AUDIT_TARGET_LIMIT = 2n;
const E2E_AGENT_FALLBACK_REVIEW_VRF_DIFFICULTY = BigInt(process.env.E2E_AGENT_FALLBACK_REVIEW_VRF_DIFFICULTY ?? "1");
const E2E_AGENT_FALLBACK_AUDIT_VRF_DIFFICULTY = BigInt(process.env.E2E_AGENT_FALLBACK_AUDIT_VRF_DIFFICULTY ?? "1");
const E2E_AGENT_FALLBACK_AUDIT_TARGET_LIMIT = BigInt(process.env.E2E_AGENT_FALLBACK_AUDIT_TARGET_LIMIT ?? "1");
const E2E_AUDIT_PHASE_START_BLOCK_OFFSET = 6n;
const E2E_LLM_TIMEOUT_MS = "300000";
const E2E_LLM_MAX_TOKENS = "2048";
const E2E_LLM_PROPOSAL_CHAR_BUDGET = "16000";
const E2E_MAX_ACTIVE_REQUESTS = Number(process.env.E2E_MAX_ACTIVE_REQUESTS ?? process.env.DAIO_MAX_ACTIVE_REQUESTS ?? "2");
const E2E_REQUEST_COUNT = Number(process.env.E2E_REQUEST_COUNT ?? "2");
const E2E_AGENT_AUTO_START_REQUESTS = booleanEnv(process.env.E2E_AGENT_AUTO_START_REQUESTS, false);

interface RunResult {
  ok: boolean;
  finalProposalScore?: bigint;
  confidence?: bigint;
}

async function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function booleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`invalid boolean env value: ${raw}`);
}

async function startContentService(relayerKey?: string): Promise<{
  process: ChildProcess;
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  const port = Number(process.env.CONTENT_SERVICE_PORT ?? 18002);
  const host = process.env.CONTENT_SERVICE_HOST ?? "127.0.0.1";
  const child = spawn("npx", ["tsx", "src/content-service/cli.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CONTENT_SERVICE_PORT: String(port),
      CONTENT_SERVICE_HOST: host,
      ...(relayerKey ? { CONTENT_RELAYER_PRIVATE_KEY: relayerKey } : {}),
    },
  });
  const baseUrl = `http://${host}:${port}`;
  const client = new ContentServiceClient(baseUrl);

  child.stdout!.on("data", (b: Buffer) => process.stdout.write(`[content] ${b.toString()}`));
  child.stderr!.on("data", (b: Buffer) => process.stderr.write(`[content:err] ${b.toString()}`));

  // Wait for health endpoint
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    try {
      if (await client.health()) break;
    } catch (_e) {
      // not ready yet
    }
    await delay(200);
  }
  if (!(await client.health())) throw new Error("content-service did not become ready");

  return {
    process: child,
    baseUrl,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill("SIGINT");
        await new Promise<void>((res) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            res();
          }, 3_000);
          child.once("exit", () => {
            clearTimeout(timer);
            res();
          });
        });
      }
    },
  };
}

function spawnAgent(opts: {
  rpcUrl: string;
  privkey: string;
  contentSvc: string;
  deploymentPath: string;
  stateDir: string;
  stateKey: string;
  agentId: bigint;
  ensName: string;
  label: string;
  reviewElectionDifficulty: bigint;
  auditElectionDifficulty: bigint;
  auditTargetLimit: bigint;
  vrfPrivkey: string;
}): ChildProcess {
  const child = spawn(
    "npx",
    [
      "tsx",
      "src/reviewer-agent/cli.ts",
      "--rpc",
      opts.rpcUrl,
      "--privkey",
      opts.privkey,
      "--content-svc",
      opts.contentSvc,
      "--deployment",
      opts.deploymentPath,
      "--state-dir",
      opts.stateDir,
      "--state-key",
      opts.stateKey,
      "--label",
      opts.label,
      "--agent-id",
      opts.agentId.toString(),
      "--ens-name",
      opts.ensName,
      "--review-election-difficulty",
      opts.reviewElectionDifficulty.toString(),
      "--audit-election-difficulty",
      opts.auditElectionDifficulty.toString(),
      "--audit-target-limit",
      opts.auditTargetLimit.toString(),
      "--vrf-privkey",
      opts.vrfPrivkey,
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LLM_TIMEOUT_MS: process.env.E2E_LLM_TIMEOUT_MS ?? E2E_LLM_TIMEOUT_MS,
        LLM_MAX_TOKENS: process.env.E2E_LLM_MAX_TOKENS ?? E2E_LLM_MAX_TOKENS,
        LLM_PROPOSAL_CHAR_BUDGET: process.env.E2E_LLM_PROPOSAL_CHAR_BUDGET ?? E2E_LLM_PROPOSAL_CHAR_BUDGET,
        DAIO_AUTO_START_REQUESTS: String(E2E_AGENT_AUTO_START_REQUESTS),
      },
    },
  );
  child.stdout!.on("data", (b: Buffer) => process.stdout.write(b));
  child.stderr!.on("data", (b: Buffer) => process.stderr.write(b));
  return child;
}

async function awaitFinalized(
  provider: JsonRpcProvider,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  core: any,
  requestId: bigint,
  timeoutMs = 600_000,
): Promise<{ score: bigint; confidence: bigint }> {
  const events = new CoreEventStream(provider, core);
  await events.start();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      events.stop();
      reject(new Error(`finalization timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    events.on("finalized", (e) => {
      const ev = e as { requestId: bigint; finalProposalScore: bigint; confidence: bigint };
      if (ev.requestId === requestId) {
        clearTimeout(timer);
        events.stop();
        resolve({ score: ev.finalProposalScore, confidence: ev.confidence });
      }
    });
    events.on("error", (err) => {
      // non-fatal — just log
      process.stderr.write(`[orchestrate] event stream error: ${err}\n`);
    });
  });
}

async function startQueuedRequests(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  core: any,
  maxToPop: number,
): Promise<Array<{ txHash: string; blockNumber: number }>> {
  const started: Array<{ txHash: string; blockNumber: number }> = [];
  let attempts = Math.max(0, maxToPop);
  try {
    const maxActive = (await core.maxActiveRequests()) as bigint;
    attempts = Math.min(attempts, Number(maxActive > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : maxActive));
    process.stdout.write(
      `[orchestrate] active window: max=${maxActive} requestedPop=${maxToPop}\n`,
    );
  } catch (_err) {
    process.stdout.write(`[orchestrate] active window views unavailable; falling back to requestedPop=${maxToPop}\n`);
  }
  for (let i = 0; i < attempts; i++) {
    try {
      await core.startNextRequest.staticCall();
      const tx = await core.startNextRequest();
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error(`startNextRequest failed: ${receipt?.hash ?? "unknown tx"}`);
      started.push({ txHash: receipt.hash, blockNumber: receipt.blockNumber });
    } catch (err) {
      const message = String((err as Error).message ?? err);
      if (message.includes("QueueEmpty") || message.includes("TooManyActiveRequests") || message.includes("BadConfig")) break;
      throw err;
    }
  }
  return started;
}

async function waitForRequestsStarted(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  core: any,
  requestIds: readonly bigint[],
  timeoutMs = 60_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = await Promise.all(
      requestIds.map(async (requestId) => {
        const lifecycle = await core.getRequestLifecycle(requestId);
        return Number(lifecycle[1] as bigint | number) as RequestStatus;
      }),
    );
    if (statuses.every((status) => status !== RequestStatus.Queued)) return;
    await delay(500);
  }
  throw new Error(`timed out waiting for agents to auto-start ${requestIds.length} queued requests`);
}

async function main(): Promise<RunResult> {
  if (!Number.isInteger(E2E_MAX_ACTIVE_REQUESTS) || E2E_MAX_ACTIVE_REQUESTS < 0) {
    throw new Error("E2E_MAX_ACTIVE_REQUESTS must be a non-negative integer");
  }
  if (!Number.isInteger(E2E_REQUEST_COUNT) || E2E_REQUEST_COUNT <= 0) {
    throw new Error("E2E_REQUEST_COUNT must be a positive integer");
  }
  process.stdout.write(`[orchestrate] starting E2E\n`);

  // 1. Hardhat node
  const node = await startHardhatNode({ port: 8545, host: "127.0.0.1" });
  process.stdout.write(`[orchestrate] hardhat ready at ${node.rpcUrl}\n`);

  const provider = new JsonRpcProvider(node.rpcUrl, undefined, { staticNetwork: true });
  // signers: 0=owner, 1=treasury, 2=requester, 3.. candidate reviewers.
  // Register the full local candidate pool, then spawn a deterministic 5-agent
  // committee that satisfies quorum=3 under the configured review/audit sortition.
  const ownerKey = HARDHAT_PRIV_KEYS[0]!;
  const treasuryKey = HARDHAT_PRIV_KEYS[1]!;
  const requesterKey = HARDHAT_PRIV_KEYS[2]!;
  const candidateKeys = HARDHAT_PRIV_KEYS.slice(3);
  const candidateVrfKeys = candidateKeys.map((_, i) => `0x${BigInt(i + 1).toString(16).padStart(64, "0")}`);

  // 2. Deploy
  const deployment = await deployAll({
    rpcUrl: node.rpcUrl,
    ownerKey,
    treasuryKey,
    requesterKey,
    reviewerKeys: candidateKeys,
    provider,
  });
  mkdirSync(path.join(ROOT, ".deployments"), { recursive: true });
  const deploymentPath = path.join(ROOT, ".deployments", "local.json");
  writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
  process.stdout.write(`[orchestrate] deployment written to ${deploymentPath}\n`);

  // 3. Content service
  const content = await startContentService(treasuryKey);
  const contentClient = new ContentServiceClient(content.baseUrl);
  process.stdout.write(`[orchestrate] content-service ready at ${content.baseUrl}\n`);

  // 4. Prepare sample paper. The document is uploaded only after the on-chain
  // request tx is verified by the content API.
  const samplePath = path.join(ROOT, "samples", "paper-001.md");
  const paperText = readFileSync(samplePath, "utf8");
  const proposalId = "paper-001";
  const proposalURI = `content://proposals/${proposalId}`;
  const proposalHash = keccak256(toUtf8Bytes(paperText));
  process.stdout.write(`[orchestrate] proposal prepared: ${proposalURI} hash=${proposalHash} bytes=${paperText.length}\n`);

  // 5. Register all candidate reviewers (orchestrator pre-registers; agents won't need to)
  const ownerWallet = new Wallet(ownerKey, provider);
  const ownerManaged = new NonceManager(ownerWallet);
  const handles = loadContracts(deployment, ownerManaged);
  const candidateVrfProviders = candidateVrfKeys.map((key) => makeSecp256k1VrfProvider(key, provider));
  const reviewerStake = parseEther(String(1000 * Math.max(1, E2E_MAX_ACTIVE_REQUESTS)));

  for (let i = 0; i < candidateKeys.length; i++) {
    const wallet = new Wallet(candidateKeys[i]!, provider);
    const ensName = `reviewer-${i + 1}.daio.eth`;
    await registerReviewerIfNeeded(handles, wallet, {
      ensName,
      agentId: BigInt(1001 + i),
      domainMask: DOMAIN_RESEARCH,
      vrfPublicKey: candidateVrfProviders[i]!.publicKey,
      stakeAmount: reviewerStake,
    });
  }
  process.stdout.write(`[orchestrate] registered ${candidateKeys.length} reviewers\n`);

  // 6. Requester approves PaymentRouter, then the content API relays signed USDAIO request intents.
  const requesterWallet = new Wallet(requesterKey, provider);
  const requesterManaged = new NonceManager(requesterWallet);
  const requesterHandles = loadContracts(deployment, requesterManaged);
  await (
    await requesterHandles.usdaio.approve(deployment.contracts.paymentRouter, parseEther("1000"))
  ).wait();
  const requests: Array<{
    requestId: bigint;
    proposalId: string;
    proposalURI: string;
    proposalHash: string;
    createTxHash: string;
    createBlock: bigint;
    predictedReviewPhaseStartBlock: bigint;
  }> = [];
  for (let i = 0; i < E2E_REQUEST_COUNT; i++) {
    const currentProposalId = i === 0 ? proposalId : `${proposalId}-${i + 1}`;
    const currentProposalURI = `content://proposals/${currentProposalId}`;
    const priorityFee = BigInt(E2E_REQUEST_COUNT - i);
    const intent = await contentClient.createUSDAIORequestIntent({
      requester: requesterWallet.address,
      proposalURI: currentProposalURI,
      text: paperText,
      rubricHash: id(`${currentProposalId}:rubric`),
      domainMask: DOMAIN_RESEARCH.toString(),
      tier: FAST,
      priorityFee: priorityFee.toString(),
      mimeType: "text/markdown",
    });
    const signature = await requesterWallet.signTypedData(
      intent.typedData.domain,
      intent.typedData.types,
      intent.typedData.message,
    );
    const relayed = await contentClient.submitRelayedRequestDocument({
      requester: requesterWallet.address,
      signature,
      deadline: intent.deadline,
      proposalURI: currentProposalURI,
      text: paperText,
      rubricHash: intent.rubricHash,
      domainMask: intent.domainMask,
      tier: intent.tier,
      priorityFee: intent.priorityFee,
      mimeType: "text/markdown",
    });
    const requestId = BigInt(relayed.relayed.requestId);
    requests.push({
      requestId,
      proposalId: currentProposalId,
      proposalURI: currentProposalURI,
      proposalHash,
      createTxHash: relayed.relayed.txHash,
      createBlock: BigInt(relayed.relayed.blockNumber),
      predictedReviewPhaseStartBlock: 0n,
    });
    process.stdout.write(
      `[orchestrate] relayed createRequest requestId=${requestId} relayer=${relayed.relayed.relayer} tx=${relayed.relayed.txHash}\n`,
    );
    process.stdout.write(
      `[orchestrate] proposal accepted requestId=${requestId}: ${relayed.document.proposal.uri} hash=${relayed.document.proposal.hash}\n`,
    );
  }

  const lastCreateBlock = requests[requests.length - 1]!.createBlock;
  for (let i = 0; i < requests.length; i++) {
    requests[i]!.predictedReviewPhaseStartBlock = lastCreateBlock + BigInt(i + 1);
  }

  // 7. Prescreen for a passing committee using real VRF proofs.
  const lifecycles = await Promise.all(requests.map((req) => handles.core.getRequestLifecycle(req.requestId)));
  const primaryRequest = requests[0]!;
  const primaryLifecycle = lifecycles[0]!;
  const committeeEpoch = BigInt(primaryLifecycle[5] as bigint | number);
  const auditEpoch = BigInt(primaryLifecycle[6] as bigint | number);

  const prescreen = await preScreenCommittee({
    handles,
    candidateKeys,
    vrfProviders: candidateVrfProviders,
    finalityFactor: 2n,
    reviewElectionDifficulty: E2E_REVIEW_VRF_DIFFICULTY,
    auditElectionDifficulty: E2E_AUDIT_VRF_DIFFICULTY,
    agentCount: E2E_AGENT_COUNT,
    quorum: E2E_QUORUM,
    auditTargetLimit: E2E_AUDIT_TARGET_LIMIT,
    provider,
    reviewPhaseStartBlock: primaryRequest.predictedReviewPhaseStartBlock,
    auditPhaseStartBlockOffset: E2E_AUDIT_PHASE_START_BLOCK_OFFSET,
    requestId: primaryRequest.requestId,
    committeeEpoch,
    auditEpoch,
    additionalRequests: requests.slice(1).map((req, idx) => {
      const lifecycle = lifecycles[idx + 1]!;
      return {
        requestId: req.requestId,
        reviewPhaseStartBlock: req.predictedReviewPhaseStartBlock,
        committeeEpoch: BigInt(lifecycle[5] as bigint | number),
        auditEpoch: BigInt(lifecycle[6] as bigint | number),
      };
    }),
  });
  process.stdout.write(
    `[orchestrate] prescreen committee: ${prescreen.addresses.join(", ")}\n`,
  );
  process.stdout.write(
    `[orchestrate] expected review pass: ${prescreen.reviewPassAddresses.join(", ")}\n`,
  );
  process.stdout.write(
    `[orchestrate] agent local config fallback: review=${E2E_AGENT_FALLBACK_REVIEW_VRF_DIFFICULTY} audit=${E2E_AGENT_FALLBACK_AUDIT_VRF_DIFFICULTY} targetLimit=${E2E_AGENT_FALLBACK_AUDIT_TARGET_LIMIT}; request config should come from chain\n`,
  );

  // 8. Spawn selected agents
  const stateKey = `0x${crypto.randomBytes(32).toString("hex")}`;
  const runStateRoot = path.join(ROOT, ".state", `e2e-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  mkdirSync(runStateRoot, { recursive: true });
  process.stdout.write(`[orchestrate] agent state root: ${runStateRoot}\n`);
  const agentChildren: ChildProcess[] = [];
  for (let i = 0; i < prescreen.committee.length; i++) {
    const key = prescreen.committee[i]!;
    const wallet = new Wallet(key, provider);
    const idx = candidateKeys.indexOf(key);
    const child = spawnAgent({
      rpcUrl: node.rpcUrl,
      privkey: key,
      contentSvc: content.baseUrl,
      deploymentPath,
      stateDir: path.join(runStateRoot, `agent-${i + 1}`),
      stateKey,
      agentId: BigInt(1001 + idx),
      ensName: `reviewer-${idx + 1}.daio.eth`,
      label: `R${i + 1}`,
      reviewElectionDifficulty: E2E_AGENT_FALLBACK_REVIEW_VRF_DIFFICULTY,
      auditElectionDifficulty: E2E_AGENT_FALLBACK_AUDIT_VRF_DIFFICULTY,
      auditTargetLimit: E2E_AGENT_FALLBACK_AUDIT_TARGET_LIMIT,
      vrfPrivkey: candidateVrfKeys[idx]!,
    });
    agentChildren.push(child);
    process.stdout.write(`[orchestrate] spawned agent R${i + 1} for ${wallet.address}\n`);
  }

  // give agents a moment to subscribe before we trigger phase change
  await delay(1500);

  // 9. Trigger startNextRequest. The default E2E path keeps this deterministic;
  // E2E_AGENT_AUTO_START_REQUESTS=true verifies the production keeper path.
  const finalWaits = requests.map((req) => awaitFinalized(provider, handles.rawCore, req.requestId));
  if (E2E_AGENT_AUTO_START_REQUESTS) {
    await waitForRequestsStarted(handles.core, requests.map((req) => req.requestId));
    process.stdout.write(`[orchestrate] agents auto-started queued requests\n`);
  } else {
    const startedRequests = await startQueuedRequests(handles.core, E2E_MAX_ACTIVE_REQUESTS);
    if (startedRequests.length < requests.length) {
      throw new Error(`started ${startedRequests.length}/${requests.length} queued requests; increase E2E_MAX_ACTIVE_REQUESTS for full E2E`);
    }
    const firstStarted = startedRequests[0]!;
    const startBlockNumber = firstStarted.blockNumber;
    process.stdout.write(
      `[orchestrate] startNextRequest count=${startedRequests.length} tx=${firstStarted.txHash} block=${startBlockNumber}\n`,
    );
    for (let i = 0; i < startedRequests.length; i++) {
      const req = requests[i]!;
      const started = startedRequests[i]!;
      if (BigInt(started.blockNumber) !== req.predictedReviewPhaseStartBlock) {
        process.stdout.write(
          `[orchestrate] WARNING requestId=${req.requestId}: predicted phaseStartBlock=${req.predictedReviewPhaseStartBlock} actual=${started.blockNumber}; sortition may diverge\n`,
        );
      }
    }
  }

  // 10. Await finalized
  const finalEvents = await Promise.all(finalWaits);
  for (let i = 0; i < requests.length; i++) {
    const finalEvent = finalEvents[i]!;
    process.stdout.write(
      `[orchestrate] RequestFinalized requestId=${requests[i]!.requestId} finalProposalScore=${finalEvent.score} confidence=${finalEvent.confidence}\n`,
    );
  }

  // 11. Read final lifecycle and round ledger snapshots
  const roundNames = ["review", "audit_consensus", "reputation_final"];
  const finalLifecycles = [];
  for (let reqIdx = 0; reqIdx < requests.length; reqIdx++) {
    const req = requests[reqIdx]!;
    const finalEvent = finalEvents[reqIdx]!;
    const finalLifecycle = await handles.core.getRequestLifecycle(req.requestId);
    finalLifecycles.push(finalLifecycle);
    const status = Number(finalLifecycle[1]);
    const attempt = BigInt(finalLifecycle[4] as bigint | number);
    process.stdout.write(`[orchestrate] final result requestId=${req.requestId}: ${JSON.stringify({
      status,
      finalProposalScore: finalEvent.score.toString(),
      confidence: finalEvent.confidence.toString(),
      lowConfidence: Boolean(finalLifecycle[8]),
      attempt: attempt.toString(),
    })}\n`);
    for (let round = 0; round < roundNames.length; round++) {
      const agg = await handles.roundLedger.getRoundAggregate(req.requestId, attempt, round);
      process.stdout.write(`[orchestrate] request ${req.requestId} round ${round} ${roundNames[round]} aggregate: ${JSON.stringify({
        score: (agg[0] as bigint).toString(),
        totalWeight: (agg[1] as bigint).toString(),
        confidence: (agg[2] as bigint).toString(),
        coverage: (agg[3] as bigint).toString(),
        lowConfidence: Boolean(agg[4]),
        closed: Boolean(agg[5]),
        aborted: Boolean(agg[6]),
      })}\n`);
      for (const addr of prescreen.addresses) {
        const score = await handles.roundLedger.getReviewerRoundScore(req.requestId, attempt, round, addr);
        const accounting = await handles.roundLedger.getReviewerRoundAccounting(req.requestId, attempt, round, addr);
        process.stdout.write(`[orchestrate] request ${req.requestId} round ${round} reviewer ${addr}: ${JSON.stringify({
          score: (score[0] as bigint).toString(),
          weight: (score[1] as bigint).toString(),
          weightedScore: (score[2] as bigint).toString(),
          auditScore: (score[3] as bigint).toString(),
          reputationScore: (score[4] as bigint).toString(),
          available: Boolean(score[5]),
          reward: (accounting[0] as bigint).toString(),
          slashed: (accounting[1] as bigint).toString(),
          slashCount: (accounting[2] as bigint).toString(),
          lastSlashReasonHash: String(accounting[3]),
          protocolFault: Boolean(accounting[4]),
          semanticFault: Boolean(accounting[5]),
        })}\n`);
      }
    }
  }

  // 12. Verify convenience APIs backed by the content service.
  const apiProbeAgent = prescreen.reviewPassAddresses[0]!;
  const statusRecord = await contentClient.getAgentStatus(primaryRequest.requestId, apiProbeAgent);
  const reasons = await contentClient.getAgentReasons(primaryRequest.requestId, apiProbeAgent);
  process.stdout.write(`[orchestrate] agent status API: ${JSON.stringify({
    agent: statusRecord.agent,
    phase: statusRecord.phase,
    status: statusRecord.status,
  })}\n`);
  process.stdout.write(`[orchestrate] agent reasons API: ${JSON.stringify({
    agent: reasons.agent,
    hasReview: Boolean(reasons.review),
    hasAudit: Boolean(reasons.audit),
    rawThinkingAvailable: reasons.rawThinking.available,
  })}\n`);
  if (!reasons.review || !reasons.audit) {
    throw new Error(`agent reasons API missing review or audit reasons for ${apiProbeAgent}`);
  }
  if (statusRecord.phase !== "Finalized" || statusRecord.status !== "finalized") {
    throw new Error(
      `agent status API did not report finalized state for ${apiProbeAgent}: ${statusRecord.phase}/${statusRecord.status}`,
    );
  }

  // 13. Cleanup
  process.stdout.write(`[orchestrate] cleaning up\n`);
  for (const child of agentChildren) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await delay(500);
  await content.stop();
  await node.stop();

  const ok = finalLifecycles.every((lifecycle, idx) => {
    const finalEvent = finalEvents[idx]!;
    return Number(lifecycle[1]) === RequestStatus.Finalized && finalEvent.score >= 0n && finalEvent.score <= 10000n;
  });
  return {
    ok,
    finalProposalScore: finalEvents[0]!.score,
    confidence: finalEvents[0]!.confidence,
  };
}

main()
  .then((result) => {
    process.stdout.write(
      `[orchestrate] DONE ok=${result.ok} score=${result.finalProposalScore} confidence=${result.confidence}\n`,
    );
    process.exit(result.ok ? 0 : 1);
  })
  .catch((err) => {
    process.stderr.write(`[orchestrate] FATAL: ${err}\n${(err as Error).stack ?? ""}\n`);
    process.exit(1);
  });
