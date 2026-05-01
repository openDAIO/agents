import { Contract, type ContractRunner } from "ethers";
import { Artifacts } from "../../shared/abis.js";
import type { DeploymentSnapshot } from "../../shared/types.js";

// Contract methods are ABI-driven and not statically known to TypeScript.
// We type each handle as `any` to avoid forests of `as any` casts at call sites.
export interface ContractHandles {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  usdaio: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stakeVault: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reviewerRegistry: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assignmentManager: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  roundLedger: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  commitReveal: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vrfCoordinator: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vrfVerifier: any;
  // The Core contract is a ethers Contract; typed loosely for dynamic methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  core: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paymentRouter: any;
  rawCore: Contract;
}

export function loadContracts(d: DeploymentSnapshot, runner: ContractRunner): ContractHandles {
  const core = new Contract(d.contracts.core, Artifacts.DAIOCore().abi as never[], runner);
  return {
    usdaio: new Contract(d.contracts.usdaio, Artifacts.USDAIOToken().abi as never[], runner),
    stakeVault: new Contract(d.contracts.stakeVault, Artifacts.StakeVault().abi as never[], runner),
    reviewerRegistry: new Contract(
      d.contracts.reviewerRegistry,
      Artifacts.ReviewerRegistry().abi as never[],
      runner,
    ),
    assignmentManager: new Contract(
      d.contracts.assignmentManager,
      Artifacts.AssignmentManager().abi as never[],
      runner,
    ),
    roundLedger: new Contract(
      d.contracts.roundLedger,
      Artifacts.DAIORoundLedger().abi as never[],
      runner,
    ),
    commitReveal: new Contract(
      d.contracts.commitReveal,
      Artifacts.DAIOCommitRevealManager().abi as never[],
      runner,
    ),
    vrfCoordinator: new Contract(
      d.contracts.vrfCoordinator,
      Artifacts.DAIOVRFCoordinator().abi as never[],
      runner,
    ),
    vrfVerifier: new Contract(
      d.contracts.vrfVerifier,
      Artifacts.FRAINVRFVerifier().abi as never[],
      runner,
    ),
    core,
    rawCore: core,
    paymentRouter: new Contract(
      d.contracts.paymentRouter,
      Artifacts.PaymentRouter().abi as never[],
      runner,
    ),
  };
}
