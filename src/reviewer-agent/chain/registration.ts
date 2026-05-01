import { id, parseEther, NonceManager, type Wallet } from "ethers";
import type { ContractHandles } from "./contracts.js";

export interface RegisterParams {
  ensName: string;
  agentId: bigint;
  domainMask: bigint;
  vrfPublicKey: [bigint, bigint];
  stakeAmount?: bigint;
}

export async function registerReviewerIfNeeded(
  handles: ContractHandles,
  wallet: Wallet,
  params: RegisterParams,
): Promise<{ registered: boolean; txHash?: string }> {
  const maxActiveRequests = BigInt((await handles.core.maxActiveRequests()) as bigint | number);
  const stake = params.stakeAmount ?? parseEther((1000n * (maxActiveRequests > 0n ? maxActiveRequests : 1n)).toString());
  const reviewerInfo = await handles.reviewerRegistry.getReviewer(wallet.address);
  const registered = Boolean(reviewerInfo[0]);
  if (registered) return { registered: false };

  const managed = new NonceManager(wallet);
  const usdaio = handles.usdaio.connect(managed);
  const stakeVaultAddr = await handles.stakeVault.getAddress();
  const allowance = (await handles.usdaio.allowance(wallet.address, stakeVaultAddr)) as bigint;
  if (allowance < stake) {
    const tx = await usdaio.approve(stakeVaultAddr, stake);
    await tx.wait();
  }

  const registry = handles.reviewerRegistry.connect(managed);
  const tx = await registry.registerReviewer(
    params.ensName,
    id(params.ensName),
    params.agentId,
    params.domainMask,
    params.vrfPublicKey,
    stake,
  );
  const receipt = await tx.wait();
  return { registered: true, txHash: receipt?.hash };
}
