import "dotenv/config";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { makeChainContext } from "./chain/provider.js";
import { loadContracts } from "./chain/contracts.js";
import { registerReviewerIfNeeded } from "./chain/registration.js";
import { ContentServiceClient } from "../shared/content-client.js";
import { ReviewerAgent, type AgentConfig } from "./runtime/agent.js";
import { StateStore } from "./runtime/state.js";
import type { DeploymentSnapshot } from "../shared/types.js";
import { DOMAIN_RESEARCH } from "../shared/types.js";

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
      "review-election-difficulty": { type: "string" },
      "audit-election-difficulty": { type: "string" },
      "audit-target-limit": { type: "string" },
      "auto-start-requests": { type: "boolean" },
      "disable-auto-start-requests": { type: "boolean" },
      "start-requests-max-per-tick": { type: "string" },
      "start-requests-min-interval-ms": { type: "string" },
      "start-requests-jitter-ms": { type: "string" },
    },
    strict: false,
  });

  const rpc = values.rpc ?? "http://127.0.0.1:8545";
  const privkey = values.privkey;
  const contentUrl = values["content-svc"] ?? "http://127.0.0.1:18002";
  const deploymentPath = values.deployment;
  const stateDir = values["state-dir"] ?? "./.state/agent";
  const stateKey = values["state-key"] ?? process.env.AGENT_STATE_KEY;
  const label = values.label ?? "reviewer";

  if (!privkey) throw new Error("--privkey required");
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
  const ctx = makeChainContext(rpc as string, privkey as string);
  const handles = loadContracts(deployment, ctx.wallet);
  const content = new ContentServiceClient(contentUrl as string);
  const state = StateStore.fromKey(stateDir as string, stateKey as string);

  if (values["auto-register"]) {
    const agentId = BigInt(values["agent-id"] ?? "1001");
    const ensName = (values["ens-name"] as string | undefined) ?? `${label}.daio.eth`;
    const res = await registerReviewerIfNeeded(handles, ctx.wallet, {
      ensName,
      agentId,
      domainMask: DOMAIN_RESEARCH,
      vrfPublicKey: [BigInt(deployment.vrfPublicKey[0]), BigInt(deployment.vrfPublicKey[1])],
    });
    process.stdout.write(`[agent ${label}] register: ${JSON.stringify(res)}\n`);
  }

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
    autoStartRequests: values["disable-auto-start-requests"]
      ? false
      : booleanSetting(
          values["auto-start-requests"] as boolean | undefined,
          "DAIO_AUTO_START_REQUESTS",
          true,
        ),
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
    publicKey: [BigInt(deployment.vrfPublicKey[0]), BigInt(deployment.vrfPublicKey[1])],
    proof: [
      BigInt(deployment.vrfProof[0]),
      BigInt(deployment.vrfProof[1]),
      BigInt(deployment.vrfProof[2]),
      BigInt(deployment.vrfProof[3]),
    ],
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

main().catch((err) => {
  process.stderr.write(`[agent] fatal: ${err}\n${(err as Error).stack ?? ""}\n`);
  process.exit(1);
});
