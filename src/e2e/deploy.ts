import {
  Contract,
  ContractFactory,
  NonceManager,
  Wallet,
  parseEther,
  type JsonRpcProvider,
} from "ethers";
import { Artifacts } from "../shared/abis.js";
import type { DeploymentSnapshot } from "../shared/types.js";

const FAST = 0;
const STANDARD = 1;
const CRITICAL = 2;

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

export function tierConfig(opts: {
  reviewElectionDifficulty?: number;
  auditElectionDifficulty?: number;
  reviewCommitQuorum: number;
  reviewRevealQuorum: number;
  auditCommitQuorum: number;
  auditRevealQuorum: number;
  auditTargetLimit: number;
  minIncomingAudit: number;
  auditCoverageQuorum: number;
  contributionThreshold: number;
  reviewEpochSize: number;
  auditEpochSize: number;
  finalityFactor: number;
  maxRetries: number;
  reviewCommitTimeout: number;
  reviewRevealTimeout: number;
  auditCommitTimeout: number;
  auditRevealTimeout: number;
}): unknown {
  const {
    reviewElectionDifficulty = 10000,
    auditElectionDifficulty = 10000,
    ...rest
  } = opts;
  return {
    reviewElectionDifficulty,
    auditElectionDifficulty,
    ...rest,
    minorityThreshold: 1500,
    semanticStrikeThreshold: 3,
    protocolFaultSlashBps: 500,
    missedRevealSlashBps: 100,
    semanticSlashBps: 200,
    cooldownBlocks: 100,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deploy(
  signer: any,
  artifact: { abi: unknown[]; bytecode: string },
  args: unknown[] = [],
): Promise<{ contract: Contract; address: string }> {
  const factory = new ContractFactory(artifact.abi as never[], artifact.bytecode, signer);
  const contract = (await factory.deploy(...args)) as Contract;
  await contract.waitForDeployment();
  return { contract, address: await contract.getAddress() };
}

export interface DeployInput {
  rpcUrl: string;
  ownerKey: string;
  treasuryKey: string;
  requesterKey: string;
  reviewerKeys: string[]; // n keys for n reviewers
  provider: JsonRpcProvider;
}

export async function deployAll(input: DeployInput): Promise<DeploymentSnapshot> {
  const ownerWallet = new Wallet(input.ownerKey, input.provider);
  // Wrap with NonceManager to avoid stale-nonce races during rapid sequential deploys.
  const owner = new NonceManager(ownerWallet);
  const treasury = new Wallet(input.treasuryKey, input.provider);
  const requester = new Wallet(input.requesterKey, input.provider);
  const reviewers = input.reviewerKeys.map((k) => new Wallet(k, input.provider));
  const maxActiveRequests = nonNegativeIntEnv(
    "E2E_MAX_ACTIVE_REQUESTS",
    nonNegativeIntEnv("DAIO_MAX_ACTIVE_REQUESTS", 2),
  );

  const usdaio = await deploy(owner, Artifacts.USDAIOToken(), [ownerWallet.address]);
  const stakeVault = await deploy(owner, Artifacts.StakeVault(), [usdaio.address]);
  const reviewerRegistry = await deploy(owner, Artifacts.ReviewerRegistry(), [stakeVault.address]);
  const assignmentManager = await deploy(owner, Artifacts.AssignmentManager(), []);
  const consensusScoring = await deploy(owner, Artifacts.ConsensusScoring(), []);
  const settlement = await deploy(owner, Artifacts.Settlement(), []);
  const reputationLedger = await deploy(owner, Artifacts.ReputationLedger(), []);
  const commitReveal = await deploy(owner, Artifacts.DAIOCommitRevealManager(), []);
  const priorityQueue = await deploy(owner, Artifacts.DAIOPriorityQueue(), []);
  const vrfVerifier = await deploy(owner, Artifacts.FRAINVRFVerifier(), []);
  const vrfCoordinator = await deploy(owner, Artifacts.DAIOVRFCoordinator(), [vrfVerifier.address]);
  const coreArtifact = Artifacts.DAIOCore();
  const coreImplementation = await deploy(owner, coreArtifact, []);
  const coreInitializer = new ContractFactory(coreArtifact.abi as never[], coreArtifact.bytecode, owner).interface.encodeFunctionData("initialize", [
    treasury.address,
    commitReveal.address,
    priorityQueue.address,
    vrfCoordinator.address,
    maxActiveRequests,
  ]);
  const coreProxy = await deploy(owner, Artifacts.DAIOTransparentUpgradeableProxy(), [
    coreImplementation.address,
    ownerWallet.address,
    coreInitializer,
  ]);
  const core = {
    contract: new Contract(coreProxy.address, coreArtifact.abi as never[], owner),
    address: coreProxy.address,
  };
  const roundLedger = await deploy(owner, Artifacts.DAIORoundLedger(), []);
  const infoReader = await deploy(owner, Artifacts.DAIOInfoReader(), [core.address]);

  // Wire modules
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = core.contract;
  await (await c.setModules(
    stakeVault.address,
    reviewerRegistry.address,
    assignmentManager.address,
    consensusScoring.address,
    settlement.address,
    reputationLedger.address,
  )).wait();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sv: any = stakeVault.contract;
  await (await sv.setCoreOrSettlement(core.address)).wait();
  await (await sv.setAuthorized(reviewerRegistry.address, true)).wait();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rr: any = reviewerRegistry.contract;
  await (await rr.setCore(core.address)).wait();
  await (await rr.setReputationGate(reputationLedger.address, 3, 3000, 7000)).wait();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rl: any = reputationLedger.contract;
  await (await rl.setCore(core.address)).wait();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ledger: any = roundLedger.contract;
  await (await ledger.setCore(core.address)).wait();
  await (await c.setRoundLedger(roundLedger.address)).wait();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cr: any = commitReveal.contract;
  await (await cr.setCore(core.address)).wait();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pq: any = priorityQueue.contract;
  await (await pq.setCore(core.address)).wait();

  // Tier configs
  await (
    await c.setTierConfig(
      FAST,
      tierConfig({
        reviewElectionDifficulty: 8000,
        auditElectionDifficulty: 10000,
        reviewCommitQuorum: 3,
        reviewRevealQuorum: 3,
        auditCommitQuorum: 3,
        auditRevealQuorum: 3,
        auditTargetLimit: 2,
        minIncomingAudit: 2,
        auditCoverageQuorum: 7000,
        contributionThreshold: 1000,
        reviewEpochSize: 25,
        auditEpochSize: 25,
        finalityFactor: 2,
        maxRetries: 1,
        reviewCommitTimeout: 10 * 60,
        reviewRevealTimeout: 10 * 60,
        auditCommitTimeout: 10 * 60,
        auditRevealTimeout: 10 * 60,
      }),
    )
  ).wait();
  await (
    await c.setTierConfig(
      STANDARD,
      tierConfig({
        reviewCommitQuorum: 4,
        reviewRevealQuorum: 4,
        auditCommitQuorum: 4,
        auditRevealQuorum: 4,
        auditTargetLimit: 3,
        minIncomingAudit: 3,
        auditCoverageQuorum: 8000,
        contributionThreshold: 1500,
        reviewEpochSize: 50,
        auditEpochSize: 50,
        finalityFactor: 3,
        maxRetries: 1,
        reviewCommitTimeout: 30 * 60,
        reviewRevealTimeout: 30 * 60,
        auditCommitTimeout: 30 * 60,
        auditRevealTimeout: 30 * 60,
      }),
    )
  ).wait();
  await (
    await c.setTierConfig(
      CRITICAL,
      tierConfig({
        reviewCommitQuorum: 5,
        reviewRevealQuorum: 5,
        auditCommitQuorum: 5,
        auditRevealQuorum: 5,
        auditTargetLimit: 4,
        minIncomingAudit: 4,
        auditCoverageQuorum: 10000,
        contributionThreshold: 2000,
        reviewEpochSize: 100,
        auditEpochSize: 100,
        finalityFactor: 5,
        maxRetries: 2,
        reviewCommitTimeout: 60 * 60,
        reviewRevealTimeout: 60 * 60,
        auditCommitTimeout: 60 * 60,
        auditRevealTimeout: 60 * 60,
      }),
    )
  ).wait();

  // Payment stack
  const universalRouter = await deploy(owner, Artifacts.MockUniversalRouter(), []);
  const acceptedTokenRegistry = await deploy(owner, Artifacts.AcceptedTokenRegistry(), [usdaio.address]);
  const swapAdapter = await deploy(owner, Artifacts.UniswapV4SwapAdapter(), [universalRouter.address]);
  const paymentRouter = await deploy(owner, Artifacts.PaymentRouter(), [
    usdaio.address,
    core.address,
    acceptedTokenRegistry.address,
    swapAdapter.address,
  ]);
  await (await c.setPaymentRouter(paymentRouter.address)).wait();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sa: any = swapAdapter.contract;
  await (await sa.setPaymentRouter(paymentRouter.address)).wait();

  // Fund reviewers and requester
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tok: any = usdaio.contract;
  const reviewerStake = parseEther(String(1000 * Math.max(1, maxActiveRequests)));
  for (const r of reviewers) {
    await (await tok.mint(r.address, reviewerStake)).wait();
  }
  const requesterFunds = parseEther("1000");
  await (await tok.mint(requester.address, requesterFunds)).wait();

  const network = await input.provider.getNetwork();

  return {
    chainId: Number(network.chainId),
    rpcUrl: input.rpcUrl,
    contracts: {
      usdaio: usdaio.address,
      stakeVault: stakeVault.address,
      reviewerRegistry: reviewerRegistry.address,
      assignmentManager: assignmentManager.address,
      consensusScoring: consensusScoring.address,
      settlement: settlement.address,
      reputationLedger: reputationLedger.address,
      roundLedger: roundLedger.address,
      commitReveal: commitReveal.address,
      priorityQueue: priorityQueue.address,
      vrfCoordinator: vrfCoordinator.address,
      vrfVerifier: vrfVerifier.address,
      core: core.address,
      coreImplementation: coreImplementation.address,
      infoReader: infoReader.address,
      paymentRouter: paymentRouter.address,
      acceptedTokenRegistry: acceptedTokenRegistry.address,
      swapAdapter: swapAdapter.address,
      universalRouter: universalRouter.address,
    },
    signers: {
      owner: ownerWallet.address,
      treasury: treasury.address,
      requester: requester.address,
      reviewers: reviewers.map((r) => r.address),
    },
    reviewerKeys: input.reviewerKeys,
    ownerKey: input.ownerKey,
    requesterKey: input.requesterKey,
  };
}
