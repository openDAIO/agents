import { AbiCoder, keccak256, Wallet, ZeroAddress, type JsonRpcProvider } from "ethers";
import { REVIEW_SORTITION } from "../shared/types.js";
import type { ContractHandles } from "../reviewer-agent/chain/contracts.js";
import { daioVrfMessage, type VrfProof, type VrfProofProvider, type VrfPublicKey } from "../reviewer-agent/chain/vrfProof.js";

const SCALE = 10000n;
const coder = AbiCoder.defaultAbiCoder();

export interface PreScreenInput {
  handles: ContractHandles;
  candidateKeys: string[]; // private keys of registered reviewers
  vrfProviders: VrfProofProvider[];
  finalityFactor: bigint;
  reviewElectionDifficulty: bigint;
  auditElectionDifficulty: bigint;
  agentCount: number;
  quorum: number;
  auditTargetLimit: bigint;
  provider: JsonRpcProvider;
  reviewPhaseStartBlock: bigint;
  // Retained for older callers; full-audit contracts no longer use audit phase
  // blocks for target sortition.
  auditPhaseStartBlockOffset: bigint;
  requestId: bigint;
  committeeEpoch: bigint;
  auditEpoch: bigint;
  additionalRequests?: Array<{
    requestId: bigint;
    reviewPhaseStartBlock: bigint;
    auditPhaseStartBlockOffset?: bigint;
    committeeEpoch: bigint;
    auditEpoch: bigint;
  }>;
}

export interface PreScreenResult {
  committee: string[];
  addresses: string[];
  reviewPassAddresses: string[];
}

function* combinations(values: number[], size: number, start = 0, picked: number[] = []): Generator<number[]> {
  if (picked.length === size) {
    yield picked.slice();
    return;
  }
  for (let i = start; i <= values.length - (size - picked.length); i++) {
    picked.push(values[i]!);
    yield* combinations(values, size, i + 1, picked);
    picked.pop();
  }
}

async function verifiedSortitionPass(input: {
  handles: ContractHandles;
  provider: JsonRpcProvider;
  coreAddress: string;
  publicKey: VrfPublicKey;
  proof: VrfProof;
  requestId: bigint;
  phase: string;
  epoch: bigint;
  participant: string;
  target?: string;
  phaseStartBlock: bigint;
  finalityFactor: bigint;
  difficulty: bigint;
}): Promise<boolean> {
  const target = input.target ?? ZeroAddress;
  // Prescreening predicts future phase blocks. Calling DAIOVRFCoordinator now
  // can misread blockhash(current) as zero, so verify the exact intended DAIO
  // message through the deployed pure FRAIN verifier instead.
  const message = await daioVrfMessage(input.provider, {
    coreAddress: input.coreAddress,
    requestId: input.requestId,
    phase: input.phase,
    epoch: input.epoch,
    participant: input.participant,
    target,
    phaseStartBlock: input.phaseStartBlock,
    finalityFactor: input.finalityFactor,
  });
  const randomness = (await input.handles.vrfVerifier.randomnessFromProof(
    input.publicKey,
    input.proof,
    message,
  )) as string;
  const score =
    BigInt(
      keccak256(
        coder.encode(
          ["bytes32", "uint256", "address", "address", "bytes32"],
          [input.phase, input.requestId, input.participant, target, randomness],
        ),
      ),
    ) % SCALE;
  return score < input.difficulty;
}

// Find a fixed-size agent committee where exactly `quorum` agents pass review
// sortition, and those revealed reviewers can also satisfy audit quorum.
export async function preScreenCommittee(input: PreScreenInput): Promise<PreScreenResult> {
  const wallets = input.candidateKeys.map((k) => new Wallet(k));
  if (input.vrfProviders.length !== wallets.length) {
    throw new Error("prescreen: vrfProviders length must match candidateKeys length");
  }
  const coreAddress = await input.handles.core.getAddress();
  const requests = [
    {
      requestId: input.requestId,
      reviewPhaseStartBlock: input.reviewPhaseStartBlock,
      auditPhaseStartBlockOffset: input.auditPhaseStartBlockOffset,
      committeeEpoch: input.committeeEpoch,
      auditEpoch: input.auditEpoch,
    },
    ...(input.additionalRequests ?? []).map((req) => ({
      ...req,
      auditPhaseStartBlockOffset: req.auditPhaseStartBlockOffset ?? input.auditPhaseStartBlockOffset,
    })),
  ];
  const requiredAuditTargets = input.quorum - 1;
  if (input.agentCount < input.quorum) throw new Error("prescreen: agentCount must be >= quorum");
  if (requiredAuditTargets <= 0) throw new Error("prescreen: audit target requirement must be positive");
  if (input.auditElectionDifficulty !== SCALE) {
    throw new Error("prescreen: full-audit flow requires auditElectionDifficulty=10000");
  }
  if (input.auditTargetLimit !== BigInt(requiredAuditTargets)) {
    throw new Error(`prescreen: full-audit flow requires auditTargetLimit = quorum - 1 (${requiredAuditTargets})`);
  }

  // Memoize sortition checks
  const reviewCache = new Map<string, boolean>();

  const reviewPass = async (idx: number, req: (typeof requests)[number]): Promise<boolean> => {
    const addr = wallets[idx]!.address;
    const key = `${req.requestId}|${req.reviewPhaseStartBlock}|${req.committeeEpoch}|${addr}`;
    if (reviewCache.has(key)) return reviewCache.get(key)!;
    const vrf = input.vrfProviders[idx]!;
    const proof = await vrf.proofFor({
      coreAddress,
      requestId: req.requestId,
      phase: REVIEW_SORTITION,
      epoch: req.committeeEpoch,
      participant: addr,
      phaseStartBlock: req.reviewPhaseStartBlock,
      finalityFactor: input.finalityFactor,
    });
    const ok = await verifiedSortitionPass({
      handles: input.handles,
      provider: input.provider,
      coreAddress,
      publicKey: vrf.publicKey,
      proof,
      requestId: req.requestId,
      phase: REVIEW_SORTITION,
      epoch: req.committeeEpoch,
      participant: addr,
      phaseStartBlock: req.reviewPhaseStartBlock,
      finalityFactor: input.finalityFactor,
      difficulty: input.reviewElectionDifficulty,
    });
    reviewCache.set(key, ok);
    return ok;
  };

  const indexes = wallets.map((_, i) => i);
  for (const combo of combinations(indexes, input.agentCount)) {
    let firstReviewPassIndexes: number[] | undefined;
    let satisfiesAllRequests = true;

    for (const req of requests) {
      const reviewPassIndexes: number[] = [];
      for (const idx of combo) {
        if (await reviewPass(idx, req)) reviewPassIndexes.push(idx);
      }
      if (reviewPassIndexes.length < input.quorum) {
        satisfiesAllRequests = false;
        break;
      }

      if (reviewPassIndexes.length - 1 < requiredAuditTargets) {
        satisfiesAllRequests = false;
        break;
      }
      firstReviewPassIndexes ??= reviewPassIndexes;
    }
    if (!satisfiesAllRequests || !firstReviewPassIndexes) continue;

    return {
      committee: combo.map((idx) => input.candidateKeys[idx]!),
      addresses: combo.map((idx) => wallets[idx]!.address),
      reviewPassAddresses: firstReviewPassIndexes.map((idx) => wallets[idx]!.address),
    };
  }
  throw new Error(
    `prescreen: no ${input.agentCount}-agent committee satisfies quorum=${input.quorum} across ${requests.length} request(s); tried ${wallets.length} candidates`,
  );
}
