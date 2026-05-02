import { FallbackProvider, JsonRpcProvider, type Provider, type TransactionReceipt } from "ethers";

export interface RpcFailoverOptions {
  stallTimeoutMs?: number;
  quorum?: number;
  eventQuorum?: number;
  eventWorkers?: number;
  cacheTimeoutMs?: number;
  batchMaxCount?: number;
  readRetries?: number;
  readRetryBaseMs?: number;
  txWaitRetries?: number;
  txWaitRetryBaseMs?: number;
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
    batchMaxCount: parseIntegerEnv(env, "RPC_BATCH_MAX_COUNT"),
    readRetries: parseIntegerEnv(env, "RPC_READ_RETRIES"),
    readRetryBaseMs: parseIntegerEnv(env, "RPC_READ_RETRY_BASE_MS"),
    txWaitRetries: parseIntegerEnv(env, "RPC_TX_WAIT_RETRIES"),
    txWaitRetryBaseMs: parseIntegerEnv(env, "RPC_TX_WAIT_RETRY_BASE_MS"),
  };
}

function makeJsonRpcProvider(url: string, options: RpcFailoverOptions): JsonRpcProvider {
  const batchMaxCount = positiveInteger(options.batchMaxCount, 1);
  return new JsonRpcProvider(url, undefined, {
    staticNetwork: true,
    batchMaxCount,
    batchStallTime: batchMaxCount === 1 ? 0 : undefined,
  });
}

export function makeRpcProvider(urls: readonly string[], options: RpcFailoverOptions = {}): Provider {
  if (urls.length === 0) throw new Error("at least one RPC URL is required");
  if (urls.length === 1) {
    return makeJsonRpcProvider(urls[0]!, options);
  }

  const stallTimeout = positiveInteger(options.stallTimeoutMs, 750, 0);
  const providers = urls.map((url, index) => ({
    provider: makeJsonRpcProvider(url, options),
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    for (const key of ["code", "errorName", "shortMessage", "message", "reason", "data", "info", "error", "cause"]) {
      visit(obj[key]);
    }
  };
  visit(err);
  return parts.join(" ");
}

export function formatRpcError(err: unknown): string {
  if (err instanceof Error) {
    const detail = deepErrorText(err);
    return detail && detail !== err.message ? `${err.message} (${detail})` : err.message;
  }
  return deepErrorText(err) || String(err);
}

export function isRetryableRpcError(err: unknown): boolean {
  const shaped = err as { code?: string };
  if (shaped.code === "CALL_EXCEPTION" || shaped.code === "INSUFFICIENT_FUNDS" || shaped.code === "ACTION_REJECTED") {
    return false;
  }
  const text = deepErrorText(err).toLowerCase();
  return (
    shaped.code === "SERVER_ERROR" ||
    shaped.code === "NETWORK_ERROR" ||
    shaped.code === "TIMEOUT" ||
    text.includes("request timeout") ||
    text.includes("timeout") ||
    text.includes("temporar") ||
    text.includes("rate limit") ||
    text.includes("too many request") ||
    text.includes("fetch failed") ||
    text.includes("socket") ||
    text.includes("econnreset") ||
    text.includes("und_err") ||
    text.includes("408") ||
    text.includes("429") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504")
  );
}

export function installRpcProcessGuards(label: string): void {
  const key = Symbol.for("daio.rpcProcessGuardsInstalled");
  const processWithGuard = process as typeof process & { [key]?: boolean };
  if (processWithGuard[key]) return;
  processWithGuard[key] = true;

  process.on("unhandledRejection", (reason) => {
    if (isRetryableRpcError(reason)) {
      process.stderr.write(`[${label}] suppressed retryable provider rejection: ${formatRpcError(reason)}\n`);
      return;
    }
    process.stderr.write(`[${label}] fatal unhandled rejection: ${formatRpcError(reason)}\n`);
    process.exit(1);
  });

  process.on("uncaughtException", (err) => {
    process.stderr.write(`[${label}] uncaught exception: ${formatRpcError(err)}\n`);
    if (!isRetryableRpcError(err)) {
      process.exit(1);
    }
  });
}

export interface WaitableTransaction {
  hash: string;
  wait(confirmations?: number): Promise<TransactionReceipt | null>;
}

export async function waitForTransactionWithRetries(
  tx: WaitableTransaction,
  confirmations = 1,
  options: RpcFailoverOptions = rpcFailoverOptionsFromEnv(),
): Promise<TransactionReceipt | null> {
  const attempts = positiveInteger(options.txWaitRetries ?? options.readRetries, 5);
  const baseMs = positiveInteger(options.txWaitRetryBaseMs ?? options.readRetryBaseMs, 1_000, 0);
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await tx.wait(confirmations);
    } catch (err) {
      lastErr = err;
      if (!isRetryableRpcError(err) || attempt === attempts - 1) break;
      await delay(baseMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

export async function withRpcReadRetries<T>(
  task: () => Promise<T>,
  options: RpcFailoverOptions = rpcFailoverOptionsFromEnv(),
): Promise<T> {
  const attempts = positiveInteger(options.readRetries, 3);
  const baseMs = positiveInteger(options.readRetryBaseMs, 500, 0);
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await task();
    } catch (err) {
      lastErr = err;
      if (!isRetryableRpcError(err) || attempt === attempts - 1) break;
      await delay(baseMs * 2 ** attempt);
    }
  }
  throw lastErr;
}
