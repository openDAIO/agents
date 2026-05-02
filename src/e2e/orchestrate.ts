import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, JsonRpcSigner, NonceManager, Wallet, ZeroAddress, getAddress, id, keccak256, parseEther, toUtf8Bytes } from "ethers";
import { startHardhatNode, HARDHAT_PRIV_KEYS } from "./hardhat.js";
import { deployAll, tierConfig } from "./deploy.js";
import { loadContracts } from "../reviewer-agent/chain/contracts.js";
import type { RegisterParams } from "../reviewer-agent/chain/registration.js";
import { preScreenCommittee } from "./sortition-prescreen.js";
import { ContentServiceClient } from "../shared/content-client.js";
import type { DeploymentSnapshot } from "../shared/types.js";
import { DOMAIN_RESEARCH, RequestStatus } from "../shared/types.js";
import { CoreEventStream } from "../reviewer-agent/chain/events.js";
import { makeSecp256k1VrfProvider } from "../reviewer-agent/chain/vrfProof.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");

const FAST = 0;
const E2E_AGENT_COUNT = Number(process.env.E2E_AGENT_COUNT ?? "5");
const E2E_QUORUM = Number(process.env.E2E_QUORUM ?? "3");
const E2E_REVIEW_VRF_DIFFICULTY = BigInt(process.env.E2E_REVIEW_VRF_DIFFICULTY ?? "8000");
const E2E_AUDIT_VRF_DIFFICULTY = BigInt(process.env.E2E_AUDIT_VRF_DIFFICULTY ?? "10000");
const E2E_AUDIT_TARGET_LIMIT = BigInt(process.env.E2E_AUDIT_TARGET_LIMIT ?? "2");
const E2E_AGENT_FALLBACK_REVIEW_VRF_DIFFICULTY = BigInt(process.env.E2E_AGENT_FALLBACK_REVIEW_VRF_DIFFICULTY ?? "1");
const E2E_AGENT_FALLBACK_AUDIT_VRF_DIFFICULTY = BigInt(process.env.E2E_AGENT_FALLBACK_AUDIT_VRF_DIFFICULTY ?? "1");
const E2E_AGENT_FALLBACK_AUDIT_TARGET_LIMIT = BigInt(process.env.E2E_AGENT_FALLBACK_AUDIT_TARGET_LIMIT ?? "1");
const E2E_AUDIT_PHASE_START_BLOCK_OFFSET = 6n;
const E2E_LLM_TIMEOUT_MS = "300000";
const E2E_LLM_MAX_TOKENS = "2048";
const E2E_LLM_PROPOSAL_CHAR_BUDGET = "16000";
const E2E_MAX_ACTIVE_REQUESTS = Number(process.env.E2E_MAX_ACTIVE_REQUESTS ?? process.env.DAIO_MAX_ACTIVE_REQUESTS ?? "2");
const E2E_REQUEST_COUNT = Number(process.env.E2E_REQUEST_COUNT ?? "2");
const E2E_EVENT_POLL_INTERVAL_MS = Number(process.env.E2E_EVENT_POLL_INTERVAL_MS ?? "500");
const E2E_AGENT_EVENT_POLL_INTERVAL_MS = Number(process.env.E2E_AGENT_EVENT_POLL_INTERVAL_MS ?? E2E_EVENT_POLL_INTERVAL_MS);
const E2E_AGENT_AUTO_START_REQUESTS = booleanEnv(process.env.E2E_AGENT_AUTO_START_REQUESTS, false);
const E2E_CHAIN_MODE = process.env.E2E_CHAIN_MODE ?? (booleanEnv(process.env.E2E_SEPOLIA_FORK, false) ? "sepolia-fork" : "local");
const E2E_SEPOLIA_DEPLOYMENT_PATH = path.resolve(
  ROOT,
  process.env.E2E_SEPOLIA_DEPLOYMENT_PATH ?? ".deployments/sepolia.json",
);
const E2E_SEPOLIA_FORK_BLOCK_RAW =
  process.env.E2E_SEPOLIA_FORK_BLOCK?.trim() ? process.env.E2E_SEPOLIA_FORK_BLOCK : process.env.HARDHAT_FORK_BLOCK;
const E2E_SEPOLIA_FORK_BLOCK =
  E2E_SEPOLIA_FORK_BLOCK_RAW && E2E_SEPOLIA_FORK_BLOCK_RAW.trim() !== ""
    ? Number(E2E_SEPOLIA_FORK_BLOCK_RAW)
    : undefined;

interface ExternalE2EAccounts {
  requesterKey: string;
  relayerKey: string;
  agentKeys: string[];
  agentVrfKeys: string[];
  agentIds: bigint[];
  ensNames: string[];
}

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

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for external-account E2E`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function assertAddressMatchesKey(label: string, privateKey: string, expectedAddress?: string): void {
  if (!expectedAddress) return;
  const actual = new Wallet(privateKey).address;
  if (getAddress(expectedAddress) !== actual) {
    throw new Error(`${label} address does not match its configured private key`);
  }
}

function loadExternalE2EAccounts(agentCount: number): ExternalE2EAccounts | undefined {
  const hasExternalAccounts = Boolean(
    optionalEnv("DAIO_REQUESTER_PRIVATE_KEY") ||
      optionalEnv("DAIO_RELAYER_PRIVATE_KEY") ||
      optionalEnv("DAIO_AGENT_1_PRIVATE_KEY"),
  );
  if (!hasExternalAccounts) return undefined;

  const requesterKey = requireEnv("DAIO_REQUESTER_PRIVATE_KEY");
  const relayerKey = requireEnv("DAIO_RELAYER_PRIVATE_KEY");
  assertAddressMatchesKey("DAIO_REQUESTER", requesterKey, optionalEnv("DAIO_REQUESTER_ADDRESS"));
  assertAddressMatchesKey("DAIO_RELAYER", relayerKey, optionalEnv("DAIO_RELAYER_ADDRESS"));

  const agentKeys: string[] = [];
  const agentVrfKeys: string[] = [];
  const agentIds: bigint[] = [];
  const ensNames: string[] = [];
  for (let i = 1; i <= agentCount; i++) {
    const key = requireEnv(`DAIO_AGENT_${i}_PRIVATE_KEY`);
    assertAddressMatchesKey(`DAIO_AGENT_${i}`, key, optionalEnv(`DAIO_AGENT_${i}_ADDRESS`));
    agentKeys.push(key);
    agentVrfKeys.push(optionalEnv(`DAIO_AGENT_${i}_VRF_PRIVATE_KEY`) ?? key);
    agentIds.push(BigInt(optionalEnv(`DAIO_AGENT_${i}_AGENT_ID`) ?? String(1000 + i)));
    ensNames.push(optionalEnv(`DAIO_AGENT_${i}_ENS_NAME`) ?? `reviewer-${i}.daio.eth`);
  }

  return { requesterKey, relayerKey, agentKeys, agentVrfKeys, agentIds, ensNames };
}

async function startContentService(relayerKey?: string): Promise<{
  process: ChildProcess;
  baseUrl: string;
  stop: () => Promise<void>;
}>;
async function startContentService(opts: {
  relayerKey?: string;
  rpcUrl: string;
  deploymentPath: string;
  dbPath: string;
}): Promise<{
  process: ChildProcess;
  baseUrl: string;
  stop: () => Promise<void>;
}>;
async function startContentService(input?: string | {
  relayerKey?: string;
  rpcUrl: string;
  deploymentPath: string;
  dbPath: string;
}): Promise<{
  process: ChildProcess;
  baseUrl: string;
  stop: () => Promise<void>;
}> {
  const opts = typeof input === "string" ? undefined : input;
  const relayerKey = typeof input === "string" ? input : input?.relayerKey;
  const port = Number(process.env.CONTENT_SERVICE_PORT ?? 18002);
  const host = process.env.CONTENT_SERVICE_HOST ?? "127.0.0.1";
  if (opts?.dbPath) mkdirSync(path.dirname(opts.dbPath), { recursive: true });
  const child = spawn("npx", ["tsx", "src/content-service/cli.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      CONTENT_SERVICE_PORT: String(port),
      CONTENT_SERVICE_HOST: host,
      ...(opts ? {
        CONTENT_CHAIN_RPC_URL: opts.rpcUrl,
        CONTENT_DEPLOYMENT_PATH: opts.deploymentPath,
        CONTENT_DB_PATH: opts.dbPath,
      } : {}),
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

function optionalRpcUrl(): string | undefined {
  return process.env.E2E_FORK_RPC_URL || process.env.SEPOLIA_RPC_URL || process.env.HARDHAT_FORK_URL || process.env.RPC_URL;
}

function loadDeploymentSnapshot(deploymentPath: string): DeploymentSnapshot {
  if (!existsSync(deploymentPath)) throw new Error(`deployment snapshot not found at ${deploymentPath}`);
  return JSON.parse(readFileSync(deploymentPath, "utf8")) as DeploymentSnapshot;
}

function quantityHex(value: bigint): string {
  return `0x${value.toString(16)}`;
}

async function setForkEthBalance(provider: JsonRpcProvider, address: string, amount = parseEther("100")): Promise<void> {
  await provider.send("hardhat_setBalance", [getAddress(address), quantityHex(amount)]);
}

async function impersonateAccount(provider: JsonRpcProvider, address: string): Promise<NonceManager> {
  const account = getAddress(address);
  await provider.send("hardhat_impersonateAccount", [account]);
  await provider.send("hardhat_setBalance", [account, quantityHex(parseEther("100"))]);
  return new NonceManager(new JsonRpcSigner(provider, account));
}

async function prepareSepoliaForkState(input: {
  provider: JsonRpcProvider;
  deployment: DeploymentSnapshot;
  candidateKeys: string[];
  requesterKey: string;
  relayerKey?: string;
  localFunderKey: string;
  reviewerStake: bigint;
}): Promise<void> {
  const readHandles = loadContracts(input.deployment, input.provider);
  const registryOwner = process.env.E2E_FORK_OWNER_ADDRESS ?? String(await readHandles.reviewerRegistry.owner());
  const owner = await impersonateAccount(input.provider, registryOwner);
  const ownerHandles = loadContracts(input.deployment, owner);

  if (booleanEnv(process.env.E2E_FORK_DISABLE_IDENTITY_MODULES, true)) {
    const ensVerifier = getAddress(String(await readHandles.reviewerRegistry.ensVerifier()));
    const erc8004Adapter = getAddress(String(await readHandles.reviewerRegistry.erc8004Adapter()));
    if (ensVerifier !== ZeroAddress || erc8004Adapter !== ZeroAddress) {
      await (await ownerHandles.reviewerRegistry.setIdentityModules(ZeroAddress, ZeroAddress)).wait();
      process.stdout.write(`[orchestrate] sepolia fork: disabled reviewer ENS/ERC8004 gates for local test agents\n`);
    }
  }

  if (booleanEnv(process.env.E2E_FORK_CONFIGURE_FAST_TIER, true)) {
    await (
      await ownerHandles.core.setTierConfig(
        FAST,
        tierConfig({
          reviewElectionDifficulty: Number(E2E_REVIEW_VRF_DIFFICULTY),
          auditElectionDifficulty: Number(E2E_AUDIT_VRF_DIFFICULTY),
          reviewCommitQuorum: E2E_QUORUM,
          reviewRevealQuorum: E2E_QUORUM,
          auditCommitQuorum: E2E_QUORUM,
          auditRevealQuorum: E2E_QUORUM,
          auditTargetLimit: Number(E2E_AUDIT_TARGET_LIMIT),
          minIncomingAudit: 1,
          auditCoverageQuorum: 7000,
          contributionThreshold: 1000,
          reviewEpochSize: 25,
          auditEpochSize: 25,
          finalityFactor: 2,
          maxRetries: 0,
          reviewCommitTimeout: 30 * 60,
          reviewRevealTimeout: 30 * 60,
          auditCommitTimeout: 30 * 60,
          auditRevealTimeout: 30 * 60,
        }),
      )
    ).wait();
    process.stdout.write(
      `[orchestrate] sepolia fork: configured Fast tier for agents=${E2E_AGENT_COUNT} quorum=${E2E_QUORUM} reviewDiff=${E2E_REVIEW_VRF_DIFFICULTY} auditDiff=${E2E_AUDIT_VRF_DIFFICULTY}\n`,
    );
  }

  const funder = new NonceManager(new Wallet(input.localFunderKey, input.provider));
  const funderHandles = loadContracts(input.deployment, funder);
  const requester = new Wallet(input.requesterKey);
  await setForkEthBalance(input.provider, requester.address);
  if (input.relayerKey) await setForkEthBalance(input.provider, new Wallet(input.relayerKey).address);
  for (const key of input.candidateKeys) {
    await setForkEthBalance(input.provider, new Wallet(key).address);
  }
  await (await funderHandles.usdaio.mint(requester.address, parseEther("1000"))).wait();
  for (const key of input.candidateKeys) {
    await (await funderHandles.usdaio.mint(new Wallet(key).address, input.reviewerStake)).wait();
  }
  process.stdout.write(`[orchestrate] sepolia fork: minted USDAIO to local requester and reviewer wallets\n`);
}

async function ensureReviewerRegisteredForE2E(
  handles: ReturnType<typeof loadContracts>,
  wallet: Wallet,
  params: RegisterParams,
): Promise<{ updated: boolean; txHash?: string }> {
  const targetStake = params.stakeAmount ?? parseEther("1000");
  const reviewerInfo = await handles.reviewerRegistry.getReviewer(wallet.address);
  const registered = Boolean(reviewerInfo[0]);
  const currentStake = BigInt(reviewerInfo[4] as bigint | number);
  const registeredVrf = (await handles.reviewerRegistry.vrfPublicKey(wallet.address)) as readonly [bigint, bigint];
  const vrfMatches = registeredVrf[0] === params.vrfPublicKey[0] && registeredVrf[1] === params.vrfPublicKey[1];

  if (registered && currentStake >= targetStake && vrfMatches) {
    return { updated: false };
  }

  const stakeDelta = currentStake < targetStake ? targetStake - currentStake : 1n;
  const managed = new NonceManager(wallet);
  const stakeVaultAddr = await handles.stakeVault.getAddress();
  const allowance = (await handles.usdaio.allowance(wallet.address, stakeVaultAddr)) as bigint;
  if (allowance < stakeDelta) {
    await (await handles.usdaio.connect(managed).approve(stakeVaultAddr, stakeDelta)).wait();
  }

  const tx = await handles.reviewerRegistry.connect(managed).registerReviewer(
    params.ensName,
    id(params.ensName),
    params.agentId,
    params.domainMask,
    params.vrfPublicKey,
    stakeDelta,
  );
  const receipt = await tx.wait();
  return { updated: true, txHash: receipt?.hash };
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
  eventPollIntervalMs: number;
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
      "--event-poll-interval-ms",
      opts.eventPollIntervalMs.toString(),
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
        DAIO_EVENT_POLL_INTERVAL_MS: opts.eventPollIntervalMs.toString(),
        DAIO_REVIEW_COMMIT_GAS_FLOOR: process.env.DAIO_REVIEW_COMMIT_GAS_FLOOR ?? "7000000",
        DAIO_REVIEW_REVEAL_GAS_FLOOR: process.env.DAIO_REVIEW_REVEAL_GAS_FLOOR ?? "2000000",
        DAIO_AUDIT_COMMIT_GAS_FLOOR: process.env.DAIO_AUDIT_COMMIT_GAS_FLOOR ?? "12000000",
        DAIO_AUDIT_REVEAL_GAS_FLOOR: process.env.DAIO_AUDIT_REVEAL_GAS_FLOOR ?? "12000000",
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
  await events.start(undefined, E2E_EVENT_POLL_INTERVAL_MS);
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
  if (!["local", "sepolia-fork"].includes(E2E_CHAIN_MODE)) {
    throw new Error("E2E_CHAIN_MODE must be either local or sepolia-fork");
  }
  if (E2E_SEPOLIA_FORK_BLOCK !== undefined && (!Number.isInteger(E2E_SEPOLIA_FORK_BLOCK) || E2E_SEPOLIA_FORK_BLOCK <= 0)) {
    throw new Error("E2E_SEPOLIA_FORK_BLOCK must be a positive integer when set");
  }
  if (!Number.isInteger(E2E_MAX_ACTIVE_REQUESTS) || E2E_MAX_ACTIVE_REQUESTS < 0) {
    throw new Error("E2E_MAX_ACTIVE_REQUESTS must be a non-negative integer");
  }
  if (!Number.isInteger(E2E_REQUEST_COUNT) || E2E_REQUEST_COUNT <= 0) {
    throw new Error("E2E_REQUEST_COUNT must be a positive integer");
  }
  if (!Number.isInteger(E2E_EVENT_POLL_INTERVAL_MS) || E2E_EVENT_POLL_INTERVAL_MS < 100) {
    throw new Error("E2E_EVENT_POLL_INTERVAL_MS must be an integer >= 100");
  }
  if (!Number.isInteger(E2E_AGENT_EVENT_POLL_INTERVAL_MS) || E2E_AGENT_EVENT_POLL_INTERVAL_MS < 100) {
    throw new Error("E2E_AGENT_EVENT_POLL_INTERVAL_MS must be an integer >= 100");
  }
  process.stdout.write(`[orchestrate] starting E2E\n`);

  // 1. Hardhat node
  const forkRpcUrl = E2E_CHAIN_MODE === "sepolia-fork" ? optionalRpcUrl() : undefined;
  if (E2E_CHAIN_MODE === "sepolia-fork" && !forkRpcUrl) {
    throw new Error("set E2E_FORK_RPC_URL, SEPOLIA_RPC_URL, HARDHAT_FORK_URL, or RPC_URL for sepolia-fork E2E");
  }
  const node = await startHardhatNode({
    port: 8545,
    host: "127.0.0.1",
    silent: booleanEnv(process.env.E2E_HARDHAT_SILENT, true),
    fork: forkRpcUrl ? { url: forkRpcUrl, blockNumber: E2E_SEPOLIA_FORK_BLOCK } : undefined,
  });
  process.stdout.write(`[orchestrate] hardhat ready at ${node.rpcUrl}\n`);

  const provider = new JsonRpcProvider(node.rpcUrl, undefined, { staticNetwork: true });
  // signers: 0=owner, 1=treasury, 2=requester, 3.. candidate reviewers.
  // Register the full local candidate pool, then spawn a deterministic 5-agent
  // committee that satisfies quorum=3 under the configured review/audit sortition.
  const externalAccounts = loadExternalE2EAccounts(E2E_AGENT_COUNT);
  if (externalAccounts) {
    process.stdout.write(`[orchestrate] using ${externalAccounts.agentKeys.length} external E2E agent accounts from environment\n`);
  }
  const ownerKey = HARDHAT_PRIV_KEYS[0]!;
  const treasuryKey = externalAccounts?.relayerKey ?? HARDHAT_PRIV_KEYS[1]!;
  const requesterKey = externalAccounts?.requesterKey ?? HARDHAT_PRIV_KEYS[2]!;
  const candidateKeys = externalAccounts?.agentKeys ?? HARDHAT_PRIV_KEYS.slice(3);
  const candidateVrfKeys =
    externalAccounts?.agentVrfKeys ?? candidateKeys.map((_, i) => `0x${BigInt(i + 1).toString(16).padStart(64, "0")}`);
  const candidateAgentIds = externalAccounts?.agentIds ?? candidateKeys.map((_, i) => BigInt(1001 + i));
  const candidateEnsNames = externalAccounts?.ensNames ?? candidateKeys.map((_, i) => `reviewer-${i + 1}.daio.eth`);

  // 2. Deploy locally or attach to deployed Sepolia addresses on a local fork.
  let deployment: DeploymentSnapshot;
  mkdirSync(path.join(ROOT, ".deployments"), { recursive: true });
  const deploymentPath = path.join(ROOT, ".deployments", E2E_CHAIN_MODE === "sepolia-fork" ? "sepolia-fork-local.json" : "local.json");
  if (E2E_CHAIN_MODE === "sepolia-fork") {
    const network = await provider.getNetwork();
    deployment = {
      ...loadDeploymentSnapshot(E2E_SEPOLIA_DEPLOYMENT_PATH),
      chainId: Number(network.chainId),
      rpcUrl: node.rpcUrl,
    };
    process.stdout.write(`[orchestrate] using Sepolia deployment snapshot ${E2E_SEPOLIA_DEPLOYMENT_PATH}\n`);
  } else {
    deployment = await deployAll({
      rpcUrl: node.rpcUrl,
      ownerKey,
      treasuryKey,
      requesterKey,
      reviewerKeys: candidateKeys,
      provider,
    });
  }
  writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
  process.stdout.write(`[orchestrate] runtime deployment written to ${deploymentPath}\n`);

  // 3. Content service
  const contentDbPath = path.join(ROOT, ".data", `content-e2e-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.sqlite`);
  const content = await startContentService({
    relayerKey: treasuryKey,
    rpcUrl: node.rpcUrl,
    deploymentPath,
    dbPath: contentDbPath,
  });
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

  if (E2E_CHAIN_MODE === "sepolia-fork") {
    await prepareSepoliaForkState({
      provider,
      deployment,
      candidateKeys,
      requesterKey,
      relayerKey: treasuryKey,
      localFunderKey: ownerKey,
      reviewerStake,
    });
  }

  for (let i = 0; i < candidateKeys.length; i++) {
    const wallet = new Wallet(candidateKeys[i]!, provider);
    const ensName = candidateEnsNames[i]!;
    await ensureReviewerRegisteredForE2E(handles, wallet, {
      ensName,
      agentId: candidateAgentIds[i]!,
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
      stateKey: `0x${crypto.randomBytes(32).toString("hex")}`,
      agentId: candidateAgentIds[idx]!,
      ensName: candidateEnsNames[idx]!,
      label: `R${i + 1}`,
      reviewElectionDifficulty: E2E_AGENT_FALLBACK_REVIEW_VRF_DIFFICULTY,
      auditElectionDifficulty: E2E_AGENT_FALLBACK_AUDIT_VRF_DIFFICULTY,
      auditTargetLimit: E2E_AGENT_FALLBACK_AUDIT_TARGET_LIMIT,
      vrfPrivkey: candidateVrfKeys[idx]!,
      eventPollIntervalMs: E2E_AGENT_EVENT_POLL_INTERVAL_MS,
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
  let apiProbe: {
    requestId: bigint;
    agent: string;
    statusRecord: Awaited<ReturnType<ContentServiceClient["getAgentStatus"]>>;
    reasons: Awaited<ReturnType<ContentServiceClient["getAgentReasons"]>>;
  } | undefined;
  for (const req of requests) {
    for (const agent of prescreen.addresses) {
      const statusRecord = await contentClient.getAgentStatus(req.requestId, agent);
      const reasons = await contentClient.getAgentReasons(req.requestId, agent);
      if (reasons.review && reasons.audit) {
        apiProbe = { requestId: req.requestId, agent, statusRecord, reasons };
        break;
      }
    }
    if (apiProbe) break;
  }
  if (!apiProbe) throw new Error("agent reasons API did not return a review+audit pair for any finalized request");
  const { statusRecord, reasons } = apiProbe;
  process.stdout.write(`[orchestrate] agent status API: ${JSON.stringify({
    requestId: apiProbe.requestId.toString(),
    agent: statusRecord.agent,
    phase: statusRecord.phase,
    status: statusRecord.status,
  })}\n`);
  process.stdout.write(`[orchestrate] agent reasons API: ${JSON.stringify({
    requestId: apiProbe.requestId.toString(),
    agent: reasons.agent,
    hasReview: Boolean(reasons.review),
    hasAudit: Boolean(reasons.audit),
    rawThinkingAvailable: reasons.rawThinking.available,
  })}\n`);
  if (statusRecord.phase !== "Finalized" || statusRecord.status !== "finalized") {
    throw new Error(
      `agent status API did not report finalized state for ${apiProbe.agent}: ${statusRecord.phase}/${statusRecord.status}`,
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
