import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, ZeroAddress, type JsonRpcProvider } from "ethers";
import { makeSecp256k1VrfProvider } from "../reviewer-agent/chain/vrfProof.js";
import { REVIEW_SORTITION } from "../shared/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromContracts = createRequire(path.join(ROOT, "contracts", "package.json"));

function providerStub(chainId: bigint, blockNumber: number, blockHash: string): JsonRpcProvider {
  return {
    getNetwork: async () => ({ chainId }),
    getBlockNumber: async () => blockNumber,
    getBlock: async () => ({ hash: blockHash }),
  } as unknown as JsonRpcProvider;
}

function daioMessage(params: {
  chainId: bigint;
  core: string;
  requestId: bigint;
  phase: string;
  epoch: bigint;
  reviewer: string;
  target: string;
  stableBlock: bigint;
  stableBlockHash: string;
}): string {
  return AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "uint256", "bytes32", "uint256", "address", "address", "uint256", "bytes32"],
    [
      params.chainId,
      params.core,
      params.requestId,
      params.phase,
      params.epoch,
      params.reviewer,
      params.target,
      params.stableBlock,
      params.stableBlockHash,
    ],
  );
}

async function main(): Promise<void> {
  process.chdir(path.join(ROOT, "contracts"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hre = requireFromContracts("hardhat") as any;
  const verifierFactory = await hre.ethers.getContractFactory("FRAINVRFVerifier");
  const verifier = await verifierFactory.deploy();
  await verifier.waitForDeployment();

  const chainId = 31337n;
  const blockHash = `0x${"11".repeat(32)}`;
  const core = "0x0000000000000000000000000000000000000001";
  const reviewer = "0x0000000000000000000000000000000000000002";
  const provider = providerStub(chainId, 100, blockHash);
  const vrf = makeSecp256k1VrfProvider("0x01", provider);
  const proof = await vrf.proofFor({
    coreAddress: core,
    requestId: 1n,
    phase: REVIEW_SORTITION,
    epoch: 0n,
    participant: reviewer,
    phaseStartBlock: 100n,
    finalityFactor: 2n,
  });

  const message = daioMessage({
    chainId,
    core,
    requestId: 1n,
    phase: REVIEW_SORTITION,
    epoch: 0n,
    reviewer,
    target: ZeroAddress,
    stableBlock: 98n,
    stableBlockHash: blockHash,
  });
  const ok = (await verifier.verify(vrf.publicKey, proof, message)) as boolean;
  if (!ok) throw new Error("generated VRF proof did not verify");

  const randomness = (await verifier.randomnessFromProof(vrf.publicKey, proof, message)) as string;
  if (!/^0x[0-9a-fA-F]{64}$/.test(randomness)) throw new Error(`bad randomness output: ${randomness}`);

  const wrongMessage = daioMessage({
    chainId,
    core,
    requestId: 2n,
    phase: REVIEW_SORTITION,
    epoch: 0n,
    reviewer,
    target: ZeroAddress,
    stableBlock: 98n,
    stableBlockHash: blockHash,
  });
  const wrongOk = (await verifier.verify(vrf.publicKey, proof, wrongMessage)) as boolean;
  if (wrongOk) throw new Error("VRF proof verified against the wrong request message");

  process.stdout.write(`[test:vrf] ok verifier=${await verifier.getAddress()} randomness=${randomness}\n`);
}

main().catch((err) => {
  process.stderr.write(`[test:vrf] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
