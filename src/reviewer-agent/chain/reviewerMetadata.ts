import type { ContractHandles } from "./contracts.js";

export interface ReviewerMetadata {
  ensName: string;
  agentId: bigint;
}

function fallbackEnsName(reviewer: string): string {
  return `reviewer-${reviewer.slice(2, 8).toLowerCase()}.daio.eth`;
}

function resultValue<T>(result: unknown, name: string, index: number): T | undefined {
  const record = result as Record<string, unknown>;
  return (record[name] ?? (result as readonly unknown[])[index]) as T | undefined;
}

export async function readReviewerMetadata(
  handles: ContractHandles,
  reviewer: string,
): Promise<ReviewerMetadata> {
  const info = await handles.reviewerRegistry.getReviewer(reviewer);
  const rawEnsName = resultValue<string>(info, "ensName", 11);
  const rawAgentId = resultValue<bigint | number | string>(info, "agentId", 3);
  const agentId =
    rawAgentId === undefined
      ? BigInt((await handles.reviewerRegistry.agentId(reviewer)) as bigint | number)
      : BigInt(rawAgentId);

  return {
    ensName: rawEnsName && rawEnsName.length > 0 ? rawEnsName : fallbackEnsName(reviewer),
    agentId,
  };
}
