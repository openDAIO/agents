import type { Provider } from "ethers";
import { withRpcReadRetries } from "../../shared/rpc.js";

export interface PhaseTiming {
  timeoutMs: number;
  elapsedMs: number;
  remainingMs: number;
  startBlock?: number;
  latestBlock?: number;
}

function normalizeTimeoutMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export async function readPhaseTiming(
  provider: Provider,
  startBlock: number | undefined,
  phaseTimeoutMs: number,
): Promise<PhaseTiming | undefined> {
  const timeoutMs = normalizeTimeoutMs(phaseTimeoutMs);
  if (timeoutMs === 0) return undefined;
  if (startBlock === undefined) {
    return { timeoutMs, elapsedMs: 0, remainingMs: timeoutMs };
  }

  const [phaseStartBlock, latestBlock] = await withRpcReadRetries(() =>
    Promise.all([provider.getBlock(startBlock), provider.getBlock("latest")]),
  );
  if (!phaseStartBlock || !latestBlock) {
    return { timeoutMs, elapsedMs: 0, remainingMs: timeoutMs, startBlock };
  }

  const elapsedMs = Math.max(0, (latestBlock.timestamp - phaseStartBlock.timestamp) * 1_000);
  return {
    timeoutMs,
    elapsedMs,
    remainingMs: Math.max(0, timeoutMs - elapsedMs),
    startBlock,
    latestBlock: latestBlock.number,
  };
}

export async function phaseHasMinimumRemaining(
  provider: Provider,
  startBlock: number | undefined,
  phaseTimeoutMs: number | undefined,
  minRemainingMs: number | undefined,
): Promise<{ ok: true; timing?: PhaseTiming } | { ok: false; timing: PhaseTiming }> {
  const minMs =
    Number.isFinite(minRemainingMs) && (minRemainingMs ?? 0) > 0
      ? Math.trunc(minRemainingMs!)
      : 0;
  if (minMs === 0 || phaseTimeoutMs === undefined) return { ok: true };

  const timing = await readPhaseTiming(provider, startBlock, phaseTimeoutMs);
  if (!timing) return { ok: true };
  return timing.remainingMs >= minMs ? { ok: true, timing } : { ok: false, timing };
}
