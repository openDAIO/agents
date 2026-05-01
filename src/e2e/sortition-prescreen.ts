import { Wallet, type JsonRpcProvider } from "ethers";
import { sortitionPass } from "../reviewer-agent/chain/sortition.js";
import { REVIEW_SORTITION, AUDIT_SORTITION } from "../shared/types.js";
import type { ContractHandles } from "../reviewer-agent/chain/contracts.js";
import type { VrfProofProvider } from "../reviewer-agent/chain/vrfProof.js";

const SCALE = 10000n;

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
  // approximate auditPhaseStartedBlock = reviewPhaseStartBlock + 4 (mirrors test helper).
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
  const requiredAuditTargets = Math.min(Number(input.auditTargetLimit), input.quorum - 1);
  if (input.agentCount < input.quorum) throw new Error("prescreen: agentCount must be >= quorum");
  if (requiredAuditTargets <= 0) throw new Error("prescreen: audit target requirement must be positive");

  // Memoize sortition checks
  const reviewCache = new Map<string, boolean>();
  const auditCache = new Map<string, boolean>();

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
    const ok = await sortitionPass({
      vrfCoordinator: input.handles.vrfCoordinator,
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

  const auditPass = async (auditorIdx: number, targetIdx: number, req: (typeof requests)[number]): Promise<boolean> => {
    const auditor = wallets[auditorIdx]!.address;
    const target = wallets[targetIdx]!.address;
    const auditPhaseStartBlock = req.reviewPhaseStartBlock + req.auditPhaseStartBlockOffset;
    const key = `${req.requestId}|${auditPhaseStartBlock}|${req.auditEpoch}|${auditor}|${target}`;
    if (auditCache.has(key)) return auditCache.get(key)!;
    if (input.auditElectionDifficulty >= SCALE) {
      auditCache.set(key, true);
      return true;
    }
    const auditStableBlock = auditPhaseStartBlock > input.finalityFactor ? auditPhaseStartBlock - input.finalityFactor : 0n;
    const currentBlock = BigInt(await input.provider.getBlockNumber());
    if (auditStableBlock > currentBlock) {
      throw new Error(
        `prescreen: cannot evaluate future audit VRF block ${auditStableBlock}; use audit difficulty ${SCALE} or prescreen after the stable block exists`,
      );
    }
    const vrf = input.vrfProviders[auditorIdx]!;
    const proof = await vrf.proofFor({
      coreAddress,
      requestId: req.requestId,
      phase: AUDIT_SORTITION,
      epoch: req.auditEpoch,
      participant: auditor,
      target,
      phaseStartBlock: auditPhaseStartBlock,
      finalityFactor: input.finalityFactor,
    });
    const ok = await sortitionPass({
      vrfCoordinator: input.handles.vrfCoordinator,
      coreAddress,
      publicKey: vrf.publicKey,
      proof,
      requestId: req.requestId,
      phase: AUDIT_SORTITION,
      epoch: req.auditEpoch,
      participant: auditor,
      target,
      phaseStartBlock: auditPhaseStartBlock,
      finalityFactor: input.finalityFactor,
      difficulty: input.auditElectionDifficulty,
    });
    auditCache.set(key, ok);
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

      let completeAuditGraph = true;
      for (const auditorIdx of reviewPassIndexes) {
        let selectedTargets = 0;
        for (const targetIdx of reviewPassIndexes) {
          if (auditorIdx === targetIdx) continue;
          if (await auditPass(auditorIdx, targetIdx, req)) selectedTargets++;
        }
        if (selectedTargets < reviewPassIndexes.length - 1 || selectedTargets < requiredAuditTargets) {
          completeAuditGraph = false;
          break;
        }
      }
      if (!completeAuditGraph) {
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
