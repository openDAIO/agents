import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, NonceManager, Wallet, id, parseEther } from "ethers";
import { startHardhatNode, HARDHAT_PRIV_KEYS } from "./hardhat.js";
import { deployAll } from "./deploy.js";
import { loadContracts } from "../reviewer-agent/chain/contracts.js";
import { registerReviewerIfNeeded } from "../reviewer-agent/chain/registration.js";
import { preScreenTriple } from "./sortition-prescreen.js";
import { ContentServiceClient } from "../shared/content-client.js";
import type { DeploymentSnapshot } from "../shared/types.js";
import { DOMAIN_RESEARCH, RequestStatus } from "../shared/types.js";
import { CoreEventStream } from "../reviewer-agent/chain/events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");

const FAST = 0;

interface RunResult {
  ok: boolean;
  finalProposalScore?: bigint;
  confidence?: bigint;
}

async function delay(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function startContentService(): Promise<{
  process: ChildProcess;
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  const port = Number(process.env.CONTENT_SERVICE_PORT ?? 18002);
  const host = process.env.CONTENT_SERVICE_HOST ?? "127.0.0.1";
  const child = spawn("npx", ["tsx", "src/content-service/cli.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CONTENT_SERVICE_PORT: String(port), CONTENT_SERVICE_HOST: host },
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
    ],
    {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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

async function main(): Promise<RunResult> {
  process.stdout.write(`[orchestrate] starting E2E\n`);

  // 1. Hardhat node
  const node = await startHardhatNode({ port: 8545, host: "127.0.0.1" });
  process.stdout.write(`[orchestrate] hardhat ready at ${node.rpcUrl}\n`);

  const provider = new JsonRpcProvider(node.rpcUrl, undefined, { staticNetwork: true });
  // signers: 0=owner, 1=treasury, 2=requester, 3..12 candidate reviewers
  const ownerKey = HARDHAT_PRIV_KEYS[0]!;
  const treasuryKey = HARDHAT_PRIV_KEYS[1]!;
  const requesterKey = HARDHAT_PRIV_KEYS[2]!;
  const candidateKeys = HARDHAT_PRIV_KEYS.slice(3, 13); // 10 candidates

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
  const content = await startContentService();
  const contentClient = new ContentServiceClient(content.baseUrl);
  process.stdout.write(`[orchestrate] content-service ready at ${content.baseUrl}\n`);

  // 4. Upload sample paper
  const samplePath = path.join(ROOT, "samples", "paper-001.md");
  const paperText = readFileSync(samplePath, "utf8");
  const proposal = await contentClient.putProposal({
    id: "paper-001",
    text: paperText,
    mimeType: "text/markdown",
  });
  process.stdout.write(
    `[orchestrate] proposal uploaded: ${proposal.uri} hash=${proposal.hash} bytes=${paperText.length}\n`,
  );

  // 5. Register all 10 candidate reviewers (orchestrator pre-registers; agents won't need to)
  const ownerWallet = new Wallet(ownerKey, provider);
  const handles = loadContracts(deployment, ownerWallet);
  const vrfPubKey: [bigint, bigint] = [BigInt(deployment.vrfPublicKey[0]), BigInt(deployment.vrfPublicKey[1])];

  for (let i = 0; i < candidateKeys.length; i++) {
    const wallet = new Wallet(candidateKeys[i]!, provider);
    const ensName = `reviewer-${i + 1}.daio.eth`;
    await registerReviewerIfNeeded(handles, wallet, {
      ensName,
      agentId: BigInt(1001 + i),
      domainMask: DOMAIN_RESEARCH,
      vrfPublicKey: vrfPubKey,
    });
  }
  process.stdout.write(`[orchestrate] registered ${candidateKeys.length} reviewers\n`);

  // 6. Requester approve PaymentRouter + createRequest (Queued)
  const requesterWallet = new Wallet(requesterKey, provider);
  const requesterManaged = new NonceManager(requesterWallet);
  const requesterHandles = loadContracts(deployment, requesterManaged);
  await (
    await requesterHandles.usdaio.approve(deployment.contracts.paymentRouter, parseEther("1000"))
  ).wait();
  const createTx = await requesterHandles.paymentRouter.createRequestWithUSDAIO(
    proposal.uri,
    proposal.hash,
    id("paper-001:rubric"),
    DOMAIN_RESEARCH,
    FAST,
    0n,
  );
  const createReceipt = await createTx.wait();
  process.stdout.write(`[orchestrate] createRequest tx=${createReceipt!.hash}\n`);

  const requestId = 1n;
  const blockBeforeStart = BigInt(await provider.getBlockNumber());
  // Best-effort: prescreen at predicted phaseStartBlock. Actual block at
  // startNextRequest may drift slightly because subprocess spawning + RPC
  // chatter does not mine blocks but ethers' internal sequencing can race.
  // Agents do their own sortition check at runtime, so drift only reduces
  // the chance that all three pre-screened candidates pass. With 50%
  // sortition probability and only 2 needed for quorum, the run usually
  // succeeds anyway.
  const predictedReviewPhaseStartBlock = blockBeforeStart + 1n;

  // 7. Prescreen for a passing pair
  const proof: [bigint, bigint, bigint, bigint] = [
    BigInt(deployment.vrfProof[0]),
    BigInt(deployment.vrfProof[1]),
    BigInt(deployment.vrfProof[2]),
    BigInt(deployment.vrfProof[3]),
  ];
  const lifecycle = await handles.core.getRequestLifecycle(requestId);
  const committeeEpoch = BigInt(lifecycle[5] as bigint | number);
  const auditEpoch = BigInt(lifecycle[6] as bigint | number);

  const prescreen = await preScreenTriple({
    handles,
    candidateKeys,
    publicKey: vrfPubKey,
    proof,
    finalityFactor: 2n,
    reviewElectionDifficulty: 5000n,
    auditElectionDifficulty: 5000n,
    provider,
    reviewPhaseStartBlock: predictedReviewPhaseStartBlock,
    auditPhaseStartBlockOffset: 4n,
    requestId,
    committeeEpoch,
    auditEpoch,
  });
  process.stdout.write(
    `[orchestrate] prescreen triple: ${prescreen.addresses.join(", ")}\n`,
  );

  // 8. Spawn 3 agents
  const stateKey = `0x${crypto.randomBytes(32).toString("hex")}`;
  const agentChildren: ChildProcess[] = [];
  for (let i = 0; i < 3; i++) {
    const key = prescreen.triple[i]!;
    const wallet = new Wallet(key, provider);
    const idx = candidateKeys.indexOf(key);
    const child = spawnAgent({
      rpcUrl: node.rpcUrl,
      privkey: key,
      contentSvc: content.baseUrl,
      deploymentPath,
      stateDir: path.join(ROOT, ".state", `agent-${i + 1}`),
      stateKey,
      agentId: BigInt(1001 + idx),
      ensName: `reviewer-${idx + 1}.daio.eth`,
      label: `R${i + 1}`,
    });
    agentChildren.push(child);
    process.stdout.write(`[orchestrate] spawned agent R${i + 1} for ${wallet.address}\n`);
  }

  // give agents a moment to subscribe before we trigger phase change
  await delay(1500);

  // 9. Trigger startNextRequest
  const startTx = await handles.core.startNextRequest();
  const startReceipt = await startTx.wait();
  const startBlockNumber = startReceipt!.blockNumber;
  process.stdout.write(
    `[orchestrate] startNextRequest tx=${startReceipt!.hash} block=${startBlockNumber}\n`,
  );
  if (BigInt(startBlockNumber) !== predictedReviewPhaseStartBlock) {
    process.stdout.write(
      `[orchestrate] WARNING: predicted phaseStartBlock=${predictedReviewPhaseStartBlock} actual=${startBlockNumber}; sortition may diverge\n`,
    );
  }

  // 10. Await finalized
  const finalEvent = await awaitFinalized(provider, handles.rawCore, requestId);
  process.stdout.write(
    `[orchestrate] RequestFinalized requestId=${requestId} finalProposalScore=${finalEvent.score} confidence=${finalEvent.confidence}\n`,
  );

  // 11. Read final result and reviewer results
  const finalResult = await handles.core.getRequestFinalResult(requestId);
  process.stdout.write(`[orchestrate] final result: ${JSON.stringify({
    status: Number(finalResult[0]),
    finalProposalScore: (finalResult[1] as bigint).toString(),
    confidence: (finalResult[2] as bigint).toString(),
    auditCoverage: (finalResult[3] as bigint).toString(),
    scoreDispersion: (finalResult[4] as bigint).toString(),
    finalReliability: (finalResult[5] as bigint).toString(),
    lowConfidence: Boolean(finalResult[6]),
    faultSignal: (finalResult[7] as bigint).toString(),
  })}\n`);
  for (const addr of prescreen.addresses) {
    const r = await handles.core.getReviewerResult(requestId, addr);
    process.stdout.write(
      `[orchestrate] reviewer ${addr}: reportQualityMedian=${r[0]} normalizedReportQuality=${r[1]} normalizedAuditReliability=${r[3]} finalContribution=${r[4]} reward=${r[6]} covered=${r[8]} fault=${r[9]}\n`,
    );
  }

  // 12. Cleanup
  process.stdout.write(`[orchestrate] cleaning up\n`);
  for (const child of agentChildren) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  await delay(500);
  await content.stop();
  await node.stop();

  const status = Number(finalResult[0]);
  const ok =
    status === RequestStatus.Finalized &&
    (finalResult[1] as bigint) >= 0n &&
    (finalResult[1] as bigint) <= 10000n;
  return {
    ok,
    finalProposalScore: finalResult[1] as bigint,
    confidence: finalResult[2] as bigint,
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
