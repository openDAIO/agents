import { AbiCoder, keccak256, toBeHex, type Provider } from "ethers";
import type { ContractHandles } from "../chain/contracts.js";
import { withRpcReadRetries } from "../../shared/rpc.js";

export interface RuntimeConfig {
  finalityFactor: bigint;
  reviewElectionDifficulty: bigint;
  auditElectionDifficulty: bigint;
  reviewCommitQuorum: bigint;
  auditCommitQuorum: bigint;
  auditTargetLimit: bigint;
  reviewCommitTimeoutMs: number;
  reviewRevealTimeoutMs: number;
  auditCommitTimeoutMs: number;
  auditRevealTimeoutMs: number;
}

export interface ResolvedRuntimeConfig {
  config: RuntimeConfig;
  source: "contract-storage" | "fallback";
  error?: string;
}

const REQUESTS_SLOT = 14n;
const TIER_CONFIGS_SLOT = 15n;
const REQUEST_CONFIG_SLOT_OFFSET = 27n;
const UINT16_MASK = 0xffffn;
const UINT32_MASK = 0xffffffffn;
const ABI_CODER = AbiCoder.defaultAbiCoder();

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function mappingSlot(key: bigint, slot: bigint): bigint {
  return BigInt(keccak256(ABI_CODER.encode(["uint256", "uint256"], [key, slot])));
}

async function storageWord(provider: Provider, address: string, slot: bigint): Promise<bigint> {
  return BigInt(await withRpcReadRetries(() => provider.getStorage(address, toBeHex(slot, 32))));
}

function uint32Ms(word: bigint, offsetBits: bigint): number {
  return Number(((word >> offsetBits) & UINT32_MASK) * 1_000n);
}

function decodeRuntimeConfigWords(word0: bigint, word1: bigint): RuntimeConfig {
  return {
    reviewElectionDifficulty: word0 & UINT16_MASK,
    auditElectionDifficulty: (word0 >> 16n) & UINT16_MASK,
    reviewCommitQuorum: (word0 >> 32n) & UINT16_MASK,
    auditCommitQuorum: (word0 >> 64n) & UINT16_MASK,
    auditTargetLimit: (word0 >> 96n) & UINT16_MASK,
    finalityFactor: (word0 >> 192n) & UINT16_MASK,
    reviewCommitTimeoutMs: uint32Ms(word1, 80n),
    reviewRevealTimeoutMs: uint32Ms(word1, 112n),
    auditCommitTimeoutMs: uint32Ms(word1, 144n),
    auditRevealTimeoutMs: uint32Ms(word1, 176n),
  };
}

async function resolveFromStorage(
  provider: Provider,
  handles: ContractHandles,
  slot: bigint,
  fallback: RuntimeConfig,
): Promise<ResolvedRuntimeConfig> {
  try {
    const core = await handles.core.getAddress();
    const [word0, word1] = await Promise.all([
      storageWord(provider, core, slot),
      storageWord(provider, core, slot + 1n),
    ]);
    if (word0 === 0n) throw new Error(`runtime config storage word is zero at slot ${slot}`);
    return {
      config: decodeRuntimeConfigWords(word0, word1),
      source: "contract-storage",
    };
  } catch (err) {
    return {
      config: fallback,
      source: "fallback",
      error: formatError(err),
    };
  }
}

export async function resolveTierRuntimeConfig(
  provider: Provider,
  handles: ContractHandles,
  tier: bigint,
  fallback: RuntimeConfig,
): Promise<ResolvedRuntimeConfig> {
  return resolveFromStorage(provider, handles, mappingSlot(tier, TIER_CONFIGS_SLOT), fallback);
}

export async function resolveRequestRuntimeConfig(
  provider: Provider,
  handles: ContractHandles,
  requestId: bigint,
  fallback: RuntimeConfig,
): Promise<ResolvedRuntimeConfig> {
  const requestBaseSlot = mappingSlot(requestId, REQUESTS_SLOT);
  return resolveFromStorage(provider, handles, requestBaseSlot + REQUEST_CONFIG_SLOT_OFFSET, fallback);
}

export function runtimeConfigSummary(config: RuntimeConfig): Record<string, string> {
  return {
    finalityFactor: config.finalityFactor.toString(),
    reviewElectionDifficulty: config.reviewElectionDifficulty.toString(),
    auditElectionDifficulty: config.auditElectionDifficulty.toString(),
    reviewCommitQuorum: config.reviewCommitQuorum.toString(),
    auditCommitQuorum: config.auditCommitQuorum.toString(),
    auditTargetLimit: config.auditTargetLimit.toString(),
    reviewCommitTimeoutMs: config.reviewCommitTimeoutMs.toString(),
    reviewRevealTimeoutMs: config.reviewRevealTimeoutMs.toString(),
    auditCommitTimeoutMs: config.auditCommitTimeoutMs.toString(),
    auditRevealTimeoutMs: config.auditRevealTimeoutMs.toString(),
  };
}
