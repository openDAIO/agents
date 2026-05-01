import { Wallet, type JsonRpcProvider } from "ethers";
import { sortitionPass } from "../reviewer-agent/chain/sortition.js";
import { REVIEW_SORTITION, AUDIT_SORTITION } from "../shared/types.js";
import type { ContractHandles } from "../reviewer-agent/chain/contracts.js";

export interface PreScreenInput {
  handles: ContractHandles;
  candidateKeys: string[]; // private keys of registered reviewers
  publicKey: [bigint, bigint];
  proof: [bigint, bigint, bigint, bigint];
  finalityFactor: bigint;
  reviewElectionDifficulty: bigint;
  auditElectionDifficulty: bigint;
  provider: JsonRpcProvider;
  reviewPhaseStartBlock: bigint;
  // approximate auditPhaseStartedBlock = reviewPhaseStartBlock + 4 (mirrors test helper).
  auditPhaseStartBlockOffset: bigint;
  requestId: bigint;
  committeeEpoch: bigint;
  auditEpoch: bigint;
}

export interface PreScreenResult {
  triple: [string, string, string];
  addresses: [string, string, string];
}

// Find a pair of candidates such that:
//   both pass review sortition at reviewPhaseStartBlock
//   each can audit the other at reviewPhaseStartBlock + offset
// Then append a third candidate (any unused one) so we can spawn 3 agents.
export async function preScreenTriple(input: PreScreenInput): Promise<PreScreenResult> {
  const wallets = input.candidateKeys.map((k) => new Wallet(k));
  const coreAddress = await input.handles.core.getAddress();
  const auditPhaseStartBlock = input.reviewPhaseStartBlock + input.auditPhaseStartBlockOffset;

  // Memoize sortition checks
  const reviewCache = new Map<string, boolean>();
  const auditCache = new Map<string, boolean>();

  const reviewPass = async (addr: string): Promise<boolean> => {
    const key = addr;
    if (reviewCache.has(key)) return reviewCache.get(key)!;
    const ok = await sortitionPass({
      vrfCoordinator: input.handles.vrfCoordinator,
      coreAddress,
      publicKey: input.publicKey,
      proof: input.proof,
      requestId: input.requestId,
      phase: REVIEW_SORTITION,
      epoch: input.committeeEpoch,
      participant: addr,
      phaseStartBlock: input.reviewPhaseStartBlock,
      finalityFactor: input.finalityFactor,
      difficulty: input.reviewElectionDifficulty,
    });
    reviewCache.set(key, ok);
    return ok;
  };

  const auditPass = async (auditor: string, target: string): Promise<boolean> => {
    const key = `${auditor}|${target}`;
    if (auditCache.has(key)) return auditCache.get(key)!;
    const ok = await sortitionPass({
      vrfCoordinator: input.handles.vrfCoordinator,
      coreAddress,
      publicKey: input.publicKey,
      proof: input.proof,
      requestId: input.requestId,
      phase: AUDIT_SORTITION,
      epoch: input.auditEpoch,
      participant: auditor,
      target,
      phaseStartBlock: auditPhaseStartBlock,
      finalityFactor: input.finalityFactor,
      difficulty: input.auditElectionDifficulty,
    });
    auditCache.set(key, ok);
    return ok;
  };

  for (let i = 0; i < wallets.length; i++) {
    if (!(await reviewPass(wallets[i]!.address))) continue;
    for (let j = 0; j < wallets.length; j++) {
      if (i === j) continue;
      if (!(await reviewPass(wallets[j]!.address))) continue;
      if (!(await auditPass(wallets[i]!.address, wallets[j]!.address))) continue;
      if (!(await auditPass(wallets[j]!.address, wallets[i]!.address))) continue;
      // Found pair. Pick any third candidate.
      const third = wallets.find((_, idx) => idx !== i && idx !== j);
      if (!third) continue;
      const thirdIdx = wallets.indexOf(third);
      return {
        triple: [input.candidateKeys[i]!, input.candidateKeys[j]!, input.candidateKeys[thirdIdx]!],
        addresses: [wallets[i]!.address, wallets[j]!.address, third.address],
      };
    }
  }
  throw new Error(
    `prescreen: no candidate pair passes review+audit sortition at reviewPhaseStartBlock=${input.reviewPhaseStartBlock}; tried ${wallets.length} candidates`,
  );
}
