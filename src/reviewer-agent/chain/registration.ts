import { ZeroHash, namehash, NonceManager, type Wallet } from "ethers";
import type { ContractHandles } from "./contracts.js";
import { waitForTransactionWithRetries } from "../../shared/rpc.js";

export interface RegisterParams {
  ensName: string;
  agentId: bigint;
  domainMask: bigint;
  vrfPublicKey: [bigint, bigint];
  stakeAmount?: bigint;
}

export interface RegisterResult {
  registered: boolean;
  txHash?: string;
  warning?: string;
}

function deepErrorText(err: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (value === null || value === undefined || seen.has(value)) return;
    seen.add(value);
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    for (const key of ["data", "message", "shortMessage", "error", "info", "reason"]) visit(obj[key]);
  };
  visit(err);
  return parts.join(" ");
}

export async function registerReviewerIfNeeded(
  handles: ContractHandles,
  wallet: Wallet,
  params: RegisterParams,
): Promise<RegisterResult> {
  const maxActiveRequests = BigInt((await handles.core.maxActiveRequests()) as bigint | number);
  const minStake = BigInt((await handles.reviewerRegistry.minStake()) as bigint | number);
  const desiredStake = params.stakeAmount ?? minStake * (maxActiveRequests > 0n ? maxActiveRequests : 1n);
  const reviewerInfo = await handles.reviewerRegistry.getReviewer(wallet.address);
  const registered = Boolean(reviewerInfo[0]);
  const currentStake = registered ? BigInt(reviewerInfo[4] as bigint | number) : 0n;
  const stakeDelta = desiredStake > currentStake ? desiredStake - currentStake : 0n;
  if (registered && stakeDelta === 0n) return { registered: false };

  const managed = new NonceManager(wallet);
  const usdaio = handles.usdaio.connect(managed);
  const stakeVaultAddr = await handles.stakeVault.getAddress();
  const allowance = (await handles.usdaio.allowance(wallet.address, stakeVaultAddr)) as bigint;
  if (allowance < stakeDelta) {
    const tx = await usdaio.approve(stakeVaultAddr, stakeDelta);
    await waitForTransactionWithRetries(tx);
  }

  const registry = handles.reviewerRegistry.connect(managed);
  const register = (identity: { ensName: string; ensNode: string; agentId: bigint }) =>
    registry.registerReviewer(
      identity.ensName,
      identity.ensNode,
      identity.agentId,
      params.domainMask,
      params.vrfPublicKey,
      stakeDelta,
    );
  const identity = {
    ensName: params.ensName,
    ensNode: params.ensName ? namehash(params.ensName) : ZeroHash,
    agentId: params.agentId,
  };
  try {
    const tx = await register(identity);
    const receipt = await waitForTransactionWithRetries(tx);
    return { registered: !registered, txHash: receipt?.hash };
  } catch (err) {
    if (!registered) throw err;
    return {
      registered: false,
      warning: `stake_topup_failed_without_identity_overwrite: ${deepErrorText(err) || String(err)}`,
    };
  }
}
