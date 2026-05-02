import { FallbackProvider, JsonRpcProvider, type Provider } from "ethers";

export interface RpcFailoverOptions {
  stallTimeoutMs?: number;
  quorum?: number;
  eventQuorum?: number;
  eventWorkers?: number;
  cacheTimeoutMs?: number;
}

export function parseRpcUrls(primary?: string, alternates?: string): string[] {
  const values = [primary, ...(alternates?.split(/[\s,]+/) ?? [])]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const seen = new Set<string>();
  return values.filter((url) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function parseIntegerEnv(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (!raw || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(value: number | undefined, fallback: number, min = 1): number {
  if (value === undefined || !Number.isFinite(value) || value < min) return fallback;
  return Math.floor(value);
}

export function rpcFailoverOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): RpcFailoverOptions {
  return {
    stallTimeoutMs: parseIntegerEnv(env, "RPC_FAILOVER_STALL_TIMEOUT_MS"),
    quorum: parseIntegerEnv(env, "RPC_FAILOVER_QUORUM"),
    eventQuorum: parseIntegerEnv(env, "RPC_FAILOVER_EVENT_QUORUM"),
    eventWorkers: parseIntegerEnv(env, "RPC_FAILOVER_EVENT_WORKERS"),
    cacheTimeoutMs: parseIntegerEnv(env, "RPC_FAILOVER_CACHE_TIMEOUT_MS"),
  };
}

export function makeRpcProvider(urls: readonly string[], options: RpcFailoverOptions = {}): Provider {
  if (urls.length === 0) throw new Error("at least one RPC URL is required");
  if (urls.length === 1) {
    return new JsonRpcProvider(urls[0]!, undefined, { staticNetwork: true });
  }

  const stallTimeout = positiveInteger(options.stallTimeoutMs, 750, 0);
  const providers = urls.map((url, index) => ({
    provider: new JsonRpcProvider(url, undefined, { staticNetwork: true }),
    priority: index + 1,
    weight: 1,
    stallTimeout,
  }));
  const fallbackEventWorkers = Math.min(2, urls.length);
  return new FallbackProvider(providers, undefined, {
    quorum: positiveInteger(options.quorum, 1),
    eventQuorum: positiveInteger(options.eventQuorum, 1),
    eventWorkers: Math.min(positiveInteger(options.eventWorkers, fallbackEventWorkers), urls.length),
    cacheTimeout: positiveInteger(options.cacheTimeoutMs, 250, 0),
  });
}
