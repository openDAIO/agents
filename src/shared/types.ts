import { keccak256, toUtf8Bytes } from "ethers";

export const SCALE = 10000n;

export enum RequestStatus {
  None = 0,
  Queued = 1,
  ReviewCommit = 2,
  ReviewReveal = 3,
  AuditCommit = 4,
  AuditReveal = 5,
  Finalized = 6,
  Cancelled = 7,
  Failed = 8,
  Unresolved = 9,
}

export enum Tier {
  Fast = 0,
  Standard = 1,
  Critical = 2,
}

export const DOMAIN_RESEARCH = 1n;

export const REVIEW_SORTITION = keccak256(toUtf8Bytes("DAIO_REVIEW_SORTITION"));

export interface DeploymentSnapshot {
  chainId: number;
  rpcUrl: string;
  contracts: {
    usdaio: string;
    stakeVault: string;
    reviewerRegistry: string;
    assignmentManager: string;
    consensusScoring: string;
    settlement: string;
    reputationLedger: string;
    roundLedger: string;
    commitReveal: string;
    priorityQueue: string;
    vrfCoordinator: string;
    vrfVerifier: string;
    core: string;
    coreImplementation?: string;
    coreProxyAdmin?: string;
    infoReader?: string;
    paymentRouter: string;
    acceptedTokenRegistry: string;
    swapAdapter: string;
    universalRouter: string;
    ensVerifier?: string;
    erc8004Adapter?: string;
    autoConvertHook?: string;
  };
  previousConsensusScoring?: string[];
  signers?: {
    owner: string;
    treasury: string;
    requester: string;
    reviewers: string[];
  };
  reviewerKeys?: string[];
  ownerKey?: string;
  requesterKey?: string;
  vrfPublicKey?: [string, string];
  vrfProof?: [string, string, string, string];
}
