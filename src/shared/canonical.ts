import { keccak256, toUtf8Bytes } from "ethers";

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function canonicalHash(value: unknown): string {
  return keccak256(toUtf8Bytes(canonicalJson(value)));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
