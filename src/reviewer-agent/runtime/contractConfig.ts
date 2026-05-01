import { AbiCoder, keccak256, toBeHex, type JsonRpcProvider } from "ethers";
import type { ContractHandles } from "../chain/contracts.js";

export interface RuntimeConfig {
  finalityFactor: bigint;
  reviewElectionDifficulty: bigint;
  auditElectionDifficulty: bigint;
  auditTargetLimit: bigint;
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
const ABI_CODER = AbiCoder.defaultAbiCoder();

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function mappingSlot(key: bigint, slot: bigint): bigint {
  return BigInt(keccak256(ABI_CODER.encode(["uint256", "uint256"], [key, slot])));
}

async function storageWord(provider: JsonRpcProvider, address: string, slot: bigint): Promise<bigint> {
  return BigInt(await provider.getStorage(address, toBeHex(slot, 32)));
}

function decodeRuntimeConfigWord(word: bigint): RuntimeConfig {
  return {
    reviewElectionDifficulty: word & UINT16_MASK,
    auditElectionDifficulty: (word >> 16n) & UINT16_MASK,
    auditTargetLimit: (word >> 96n) & UINT16_MASK,
    finalityFactor: (word >> 192n) & UINT16_MASK,
  };
}

async function resolveFromStorage(
  provider: JsonRpcProvider,
  handles: ContractHandles,
  slot: bigint,
  fallback: RuntimeConfig,
): Promise<ResolvedRuntimeConfig> {
  try {
    const core = await handles.core.getAddress();
    const word = await storageWord(provider, core, slot);
    if (word === 0n) throw new Error(`runtime config storage word is zero at slot ${slot}`);
    return {
      config: decodeRuntimeConfigWord(word),
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
  provider: JsonRpcProvider,
  handles: ContractHandles,
  tier: bigint,
  fallback: RuntimeConfig,
): Promise<ResolvedRuntimeConfig> {
  return resolveFromStorage(provider, handles, mappingSlot(tier, TIER_CONFIGS_SLOT), fallback);
}

export async function resolveRequestRuntimeConfig(
  provider: JsonRpcProvider,
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
    auditTargetLimit: config.auditTargetLimit.toString(),
  };
}
