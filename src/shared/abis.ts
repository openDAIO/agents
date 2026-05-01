import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(here, "../../contracts/artifacts/contracts");

interface Artifact {
  abi: unknown[];
  bytecode: string;
}

const cache = new Map<string, Artifact>();

function load(relPath: string, contractName: string): Artifact {
  const key = `${relPath}/${contractName}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const file = path.join(ARTIFACTS, relPath, `${contractName}.sol`, `${contractName}.json`);
  if (!existsSync(file)) {
    throw new Error(`artifact not found: ${file} — run \`npm run compile-contracts\` first`);
  }
  const json = JSON.parse(readFileSync(file, "utf8")) as Artifact;
  const result: Artifact = { abi: json.abi, bytecode: json.bytecode };
  cache.set(key, result);
  return result;
}

export const Artifacts = {
  USDAIOToken: () => load(".", "USDAIOToken"),
  StakeVault: () => load(".", "StakeVault"),
  ReviewerRegistry: () => load(".", "ReviewerRegistry"),
  AssignmentManager: () => load(".", "AssignmentManager"),
  ConsensusScoring: () => load(".", "ConsensusScoring"),
  Settlement: () => load(".", "Settlement"),
  ReputationLedger: () => load("reputation", "ReputationLedger"),
  DAIOCommitRevealManager: () => load("wrappers", "DAIOCommitRevealManager"),
  DAIOPriorityQueue: () => load("wrappers", "DAIOPriorityQueue"),
  DAIOVRFCoordinator: () => load(".", "DAIOVRFCoordinator"),
  FRAINVRFVerifier: () => load("vendor", "FRAINVRFVerifier"),
  MockVRFCoordinator: () => load("mocks", "MockVRFCoordinator"),
  MockUniversalRouter: () => load("mocks", "MockUniversalRouter"),
  AcceptedTokenRegistry: () => load("payment", "AcceptedTokenRegistry"),
  UniswapV4SwapAdapter: () => load("payment", "UniswapV4SwapAdapter"),
  PaymentRouter: () => load("payment", "PaymentRouter"),
  DAIOCore: () => load(".", "DAIOCore"),
};

// Resolve contract folder layout dynamically — actual paths verified at compile time.
export function resolveArtifact(name: keyof typeof Artifacts): Artifact {
  return Artifacts[name]();
}
