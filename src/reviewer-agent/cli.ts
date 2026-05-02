import "dotenv/config";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatEther, parseEther, Wallet } from "ethers";
import { makeChainContext } from "./chain/provider.js";
import { loadContracts } from "./chain/contracts.js";
import { registerReviewerIfNeeded } from "./chain/registration.js";
import { ContentServiceClient } from "../shared/content-client.js";
import { ReviewerAgent, type AgentConfig } from "./runtime/agent.js";
import { StateStore } from "./runtime/state.js";
import type { DeploymentSnapshot } from "../shared/types.js";
import { DOMAIN_RESEARCH } from "../shared/types.js";
import { makeFixtureVrfProvider, makeSecp256k1VrfProvider } from "./chain/vrfProof.js";
import { installRpcProcessGuards } from "../shared/rpc.js";

async function main() {
  const { values } = parseArgs({
    options: {
      rpc: { type: "string" },
      privkey: { type: "string" },
      "content-svc": { type: "string" },
      deployment: { type: "string" },
      "state-dir": { type: "string" },
      "state-key": { type: "string" },
      label: { type: "string" },
      "auto-register": { type: "boolean", default: false },
      "agent-id": { type: "string" },
      "ens-name": { type: "string" },
      "vrf-privkey": { type: "string" },
      "event-poll-interval-ms": { type: "string" },
      "event-lookback-blocks": { type: "string" },
      "event-reorg-depth-blocks": { type: "string" },
      "review-election-difficulty": { type: "string" },
      "audit-election-difficulty": { type: "string" },
      "audit-target-limit": { type: "string" },
      "auto-start-requests": { type: "boolean" },
      "disable-auto-start-requests": { type: "boolean" },
      "keeper-enabled": { type: "boolean" },
      "disable-keeper": { type: "boolean" },
      "keeper-privkey": { type: "string" },
      "keeper-reconcile-interval-ms": { type: "string" },
      "keeper-sync-active-requests": { type: "boolean" },
      "disable-keeper-sync-active-requests": { type: "boolean" },
      "keeper-sync-max-per-tick": { type: "string" },
      "start-requests-max-per-tick": { type: "string" },
      "start-requests-min-interval-ms": { type: "string" },
      "start-requests-jitter-ms": { type: "string" },
    },
    strict: false,
  });

  const rpc = values.rpc ?? "http://127.0.0.1:8545";
  const privkey = values.privkey ?? process.env.AGENT_PRIVATE_KEY;
  const contentUrl = values["content-svc"] ?? "http://127.0.0.1:18002";
  const deploymentPath = values.deployment;
  const stateDir = values["state-dir"] ?? "./.state/agent";
  const stateKey = values["state-key"] ?? process.env.AGENT_STATE_KEY;
  const label = values.label ?? "reviewer";

  if (!privkey) throw new Error("--privkey or AGENT_PRIVATE_KEY required");
  if (!deploymentPath) throw new Error("--deployment required");
  if (!stateKey) throw new Error("--state-key or AGENT_STATE_KEY required");

  const bigintSetting = (flag: string | undefined, envName: string, fallback: bigint): bigint => {
    const raw = flag ?? process.env[envName];
    if (!raw) return fallback;
    const parsed = BigInt(raw);
    if (parsed <= 0n) throw new Error(`${envName} must be positive`);
    return parsed;
  };

  const integerSetting = (
    flag: string | undefined,
    envName: string,
    fallback: number,
    min: number,
  ): number => {
    const raw = flag ?? process.env[envName];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < min) {
      throw new Error(`${envName} must be an integer >= ${min}`);
    }
    return parsed;
  };

  const booleanSetting = (
    flag: boolean | undefined,
    envName: string,
    fallback: boolean,
  ): boolean => {
    if (flag !== undefined) return flag;
    const raw = process.env[envName];
    if (raw === undefined) return fallback;
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    throw new Error(`${envName} must be a boolean`);
  };

  const deployment = JSON.parse(readFileSync(deploymentPath as string, "utf8")) as DeploymentSnapshot;
  const ctx = makeChainContext(rpc as string, privkey as string, process.env.RPC_URLS);
  const handles = loadContracts(deployment, ctx.wallet);
  const content = new ContentServiceClient(contentUrl as string);
  const state = StateStore.fromKey(stateDir as string, stateKey as string);
  const keeperPrivateKey =
    (values["keeper-privkey"] as string | undefined) ??
    process.env.DAIO_KEEPER_PRIVATE_KEY ??
    process.env.DAIO_GLOBAL_KEEPER_PRIVATE_KEY ??
    process.env.KEEPER_PRIVATE_KEY;
  const keeperWallet = keeperPrivateKey ? new Wallet(keeperPrivateKey, ctx.provider) : undefined;
  const vrfPrivateKey = (values["vrf-privkey"] as string | undefined) ?? process.env.AGENT_VRF_PRIVATE_KEY;
  const allowFixtureVrf = booleanSetting(undefined, "DAIO_ALLOW_FIXTURE_VRF", false);
  const vrf = vrfPrivateKey
    ? makeSecp256k1VrfProvider(vrfPrivateKey, ctx.provider)
    : allowFixtureVrf && deployment.vrfPublicKey && deployment.vrfProof
      ? makeFixtureVrfProvider(
          [BigInt(deployment.vrfPublicKey[0]), BigInt(deployment.vrfPublicKey[1])],
          [
            BigInt(deployment.vrfProof[0]),
            BigInt(deployment.vrfProof[1]),
            BigInt(deployment.vrfProof[2]),
            BigInt(deployment.vrfProof[3]),
          ],
        )
      : undefined;
  if (!vrf) {
    throw new Error(
      "AGENT_VRF_PRIVATE_KEY is required; set DAIO_ALLOW_FIXTURE_VRF=true only for local mock deployments that intentionally provide vrfPublicKey and vrfProof",
    );
  }

  const expectedAgentId = BigInt(values["agent-id"] ?? "1001");
  const expectedEnsName = (values["ens-name"] as string | undefined) ?? `${label}.daio.eth`;
  const registerEns = booleanSetting(undefined, "DAIO_REGISTER_ENS", true);
  const targetStakeRaw = process.env.DAIO_AGENT_TARGET_STAKE_USDAIO ?? process.env.DAIO_AGENT_TARGET_STAKE;
  const targetStake = targetStakeRaw && targetStakeRaw.trim() !== "" ? parseEther(targetStakeRaw.trim()) : undefined;
  if (values["auto-register"]) {
    const res = await registerReviewerIfNeeded(handles, ctx.wallet, {
      ensName: registerEns ? expectedEnsName : "",
      agentId: expectedAgentId,
      domainMask: DOMAIN_RESEARCH,
      vrfPublicKey: vrf.publicKey,
      stakeAmount: targetStake,
    });
    process.stdout.write(`[agent ${label}] register: ${JSON.stringify(res)}\n`);
  }

  const reviewerInfo = await handles.reviewerRegistry.getReviewer(ctx.wallet.address);
  if (Boolean(reviewerInfo[0])) {
    const registeredVrf = (await handles.reviewerRegistry.vrfPublicKey(ctx.wallet.address)) as readonly [bigint, bigint];
    if (registeredVrf[0] !== vrf.publicKey[0] || registeredVrf[1] !== vrf.publicKey[1]) {
      throw new Error(
        `registered VRF public key does not match AGENT_VRF_PRIVATE_KEY for ${ctx.wallet.address}; re-register with the matching VRF key or use the original VRF secret`,
      );
    }
    try {
      const onchainAgentId = BigInt(reviewerInfo[3] as bigint | number);
      if (values["auto-register"] && expectedAgentId !== 0n && onchainAgentId !== expectedAgentId) {
        process.stdout.write(
          `[agent ${label}] warning: on-chain agentId=${onchainAgentId} differs from configured AGENT_ID=${expectedAgentId}; ENS/ERC8004 identity may need repair\n`,
        );
      }
      const stake = BigInt(reviewerInfo[4] as bigint | number);
      const minStake = BigInt((await handles.reviewerRegistry.minStake()) as bigint | number);
      const maxActive = BigInt((await handles.core.maxActiveRequests()) as bigint | number);
      const requiredForActiveWindow = minStake * (maxActive > 0n ? maxActive : 1n);
      const lockedStake = BigInt((await handles.reviewerRegistry.lockedStake(ctx.wallet.address)) as bigint | number);
      const availableStake = BigInt((await handles.reviewerRegistry.availableStake(ctx.wallet.address)) as bigint | number);
      process.stdout.write(
        `[agent ${label}] stake: total=${formatEther(stake)} locked=${formatEther(lockedStake)} available=${formatEther(availableStake)} min=${formatEther(minStake)} requiredForMaxActive=${formatEther(requiredForActiveWindow)}\n`,
      );
      if (stake < requiredForActiveWindow) {
        process.stdout.write(
          `[agent ${label}] warning: total stake is below maxActiveRequests window; concurrent active requests can make this reviewer ineligible\n`,
        );
      }
      if (availableStake < minStake) {
        process.stdout.write(
          `[agent ${label}] warning: available stake is below minStake; this reviewer will skip new commits until existing locks are released or stake is topped up\n`,
        );
      }
    } catch (err) {
      process.stdout.write(`[agent ${label}] warning: could not read stake diagnostics: ${(err as Error).message}\n`);
    }
  } else {
    process.stdout.write(`[agent ${label}] reviewer is not registered; set AGENT_AUTO_REGISTER=true or register before serving\n`);
  }

  const autoStartRequests = values["disable-auto-start-requests"]
    ? false
    : booleanSetting(
        values["auto-start-requests"] as boolean | undefined,
        "DAIO_AUTO_START_REQUESTS",
        true,
      );
  const keeperEnabled = values["disable-keeper"]
    ? false
    : booleanSetting(
        values["keeper-enabled"] as boolean | undefined,
        "DAIO_KEEPER_ENABLED",
        autoStartRequests,
      );
  const keeperSyncActiveRequests = values["disable-keeper-sync-active-requests"]
    ? false
    : booleanSetting(
        values["keeper-sync-active-requests"] as boolean | undefined,
        "DAIO_KEEPER_SYNC_ACTIVE_REQUESTS",
        true,
      );

  const cfg: AgentConfig = {
    finalityFactor: 2n,
    reviewElectionDifficulty: bigintSetting(
      values["review-election-difficulty"] as string | undefined,
      "DAIO_REVIEW_ELECTION_DIFFICULTY",
      5000n,
    ),
    auditElectionDifficulty: bigintSetting(
      values["audit-election-difficulty"] as string | undefined,
      "DAIO_AUDIT_ELECTION_DIFFICULTY",
      5000n,
    ),
    auditTargetLimit: bigintSetting(
      values["audit-target-limit"] as string | undefined,
      "DAIO_AUDIT_TARGET_LIMIT",
      2n,
    ),
    autoStartRequests,
    eventPollIntervalMs: integerSetting(
      values["event-poll-interval-ms"] as string | undefined,
      "DAIO_EVENT_POLL_INTERVAL_MS",
      500,
      100,
    ),
    eventLookbackBlocks: integerSetting(
      values["event-lookback-blocks"] as string | undefined,
      "DAIO_EVENT_LOOKBACK_BLOCKS",
      7_200,
      0,
    ),
    eventReorgDepthBlocks: integerSetting(
      values["event-reorg-depth-blocks"] as string | undefined,
      "DAIO_EVENT_REORG_DEPTH_BLOCKS",
      12,
      0,
    ),
    keeperEnabled,
    keeperSyncActiveRequests,
    keeperReconcileIntervalMs: integerSetting(
      values["keeper-reconcile-interval-ms"] as string | undefined,
      "DAIO_KEEPER_RECONCILE_INTERVAL_MS",
      10_000,
      0,
    ),
    keeperSyncMaxPerTick: integerSetting(
      values["keeper-sync-max-per-tick"] as string | undefined,
      "DAIO_KEEPER_SYNC_MAX_PER_TICK",
      8,
      0,
    ),
    keeperWallet,
    startRequestsMaxPerTick: integerSetting(
      values["start-requests-max-per-tick"] as string | undefined,
      "DAIO_START_REQUESTS_MAX_PER_TICK",
      2,
      0,
    ),
    startRequestsMinIntervalMs: integerSetting(
      values["start-requests-min-interval-ms"] as string | undefined,
      "DAIO_START_REQUESTS_MIN_INTERVAL_MS",
      1000,
      0,
    ),
    startRequestsJitterMs: integerSetting(
      values["start-requests-jitter-ms"] as string | undefined,
      "DAIO_START_REQUESTS_JITTER_MS",
      250,
      0,
    ),
    vrf,
    label: label as string,
  };

  const agent = new ReviewerAgent(ctx.provider, ctx.wallet, handles, content, state, cfg);
  await agent.start();

  process.on("SIGINT", () => {
    process.stdout.write(`[agent ${label}] SIGINT, stopping\n`);
    agent.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    process.stdout.write(`[agent ${label}] SIGTERM, stopping\n`);
    agent.stop();
    process.exit(0);
  });
}

installRpcProcessGuards("agent");

main().catch((err) => {
  process.stderr.write(`[agent] fatal: ${err}\n${(err as Error).stack ?? ""}\n`);
  process.exit(1);
});
