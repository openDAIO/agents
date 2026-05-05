import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ChatOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: string | null;
  promptCacheKey?: string | null;
  promptCacheRetention?: string | null;
  responseFormatJson?: boolean;
  responseCache?: boolean;
  responseCacheTtlSeconds?: number;
  responseCacheMaxEntries?: number;
  validateContent?: (content: string) => void;
}

export interface ChatResult {
  content: string;
  promptTokens?: number;
  promptCachedTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cached?: boolean;
}

export interface ChatJsonRetryOptions<T> extends ChatOptions {
  parse: (raw: unknown) => T;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  log?: (msg: string) => void;
}

export interface ChatJsonRetryResult<T> {
  llm: ChatResult;
  data: T;
  attempts: number;
  retryErrors: string[];
}

interface ResponseCacheRow {
  content: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  createdAtMs: number;
}

const DEFAULT_RESPONSE_CACHE_TTL_SECONDS = 0;
const DEFAULT_RESPONSE_CACHE_MAX_ENTRIES = 4096;
const DEFAULT_LLM_RETRY_ATTEMPTS = 3;
const DEFAULT_LLM_RETRY_BASE_MS = 1_000;
const DEFAULT_LLM_RETRY_MAX_MS = 8_000;
const DEFAULT_LOCAL_LLM_MODEL = "gpt-oss-120b";
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const PROMPT_CACHE_RETENTION_VALUES = new Set(["in_memory", "24h"]);
let responseCacheDb: Database.Database | undefined;
let responseCacheDbPathValue: string | undefined;

export function buildPromptCacheMessages(systemContent: string, userContent: string): ChatMessage[] {
  return [
    { role: "system", content: systemContent },
    { role: "user", content: userContent },
  ];
}

function assertPromptCacheMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length !== 2 || messages[0]?.role !== "system" || messages[1]?.role !== "user") {
    throw new Error("LLM prompt-cache format requires exactly two messages: system prefix followed by user input");
  }
  return messages;
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== raw.trim()) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function responseCacheTtlSeconds(options: ChatOptions): number {
  if (options.responseCacheTtlSeconds !== undefined) {
    if (!Number.isInteger(options.responseCacheTtlSeconds) || options.responseCacheTtlSeconds < 0) {
      throw new Error("responseCacheTtlSeconds must be a non-negative integer");
    }
    return options.responseCacheTtlSeconds;
  }
  return parseNonNegativeInteger(
    process.env.LLM_RESPONSE_CACHE_TTL_SECONDS,
    DEFAULT_RESPONSE_CACHE_TTL_SECONDS,
    "LLM_RESPONSE_CACHE_TTL_SECONDS",
  );
}

function responseCacheMaxEntries(options: ChatOptions): number {
  if (options.responseCacheMaxEntries !== undefined) {
    if (!Number.isInteger(options.responseCacheMaxEntries) || options.responseCacheMaxEntries < 0) {
      throw new Error("responseCacheMaxEntries must be a non-negative integer");
    }
    return options.responseCacheMaxEntries;
  }
  return parseNonNegativeInteger(
    process.env.LLM_RESPONSE_CACHE_MAX_ENTRIES,
    DEFAULT_RESPONSE_CACHE_MAX_ENTRIES,
    "LLM_RESPONSE_CACHE_MAX_ENTRIES",
  );
}

function responseCacheDbPath(): string {
  const explicit = process.env.LLM_RESPONSE_CACHE_DB_PATH?.trim();
  if (explicit) return explicit;
  const agentStateDir = process.env.AGENT_STATE_DIR?.trim();
  if (agentStateDir) return path.join(agentStateDir, "llm-response-cache.sqlite");
  const contentDbPath = process.env.CONTENT_DB_PATH?.trim();
  if (contentDbPath) return path.join(path.dirname(contentDbPath), "llm-response-cache.sqlite");
  return path.join(process.cwd(), ".data", "llm-response-cache.sqlite");
}

function getResponseCacheDb(): Database.Database {
  const dbPath = responseCacheDbPath();
  if (responseCacheDb && responseCacheDbPathValue === dbPath) return responseCacheDb;
  if (responseCacheDb) responseCacheDb.close();

  if (dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_response_cache (
      cache_key TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      created_at_ms INTEGER NOT NULL,
      accessed_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_response_cache_accessed_at
      ON llm_response_cache(accessed_at_ms);
    CREATE INDEX IF NOT EXISTS idx_llm_response_cache_created_at
      ON llm_response_cache(created_at_ms);
  `);
  responseCacheDb = db;
  responseCacheDbPathValue = dbPath;
  return db;
}

function isCacheExpired(createdAtMs: number, now: number, ttlSeconds: number): boolean {
  return ttlSeconds > 0 && now - createdAtMs >= ttlSeconds * 1000;
}

function getCachedResponse(key: string, ttlSeconds: number): ChatResult | undefined {
  const db = getResponseCacheDb();
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT
         content,
         prompt_tokens AS promptTokens,
         completion_tokens AS completionTokens,
         total_tokens AS totalTokens,
         created_at_ms AS createdAtMs
       FROM llm_response_cache
       WHERE cache_key = ?`,
    )
    .get(key) as ResponseCacheRow | undefined;
  if (!row) return undefined;
  if (isCacheExpired(row.createdAtMs, now, ttlSeconds)) {
    db.prepare("DELETE FROM llm_response_cache WHERE cache_key = ?").run(key);
    return undefined;
  }
  db.prepare("UPDATE llm_response_cache SET accessed_at_ms = ? WHERE cache_key = ?").run(now, key);
  return {
    content: row.content,
    promptTokens: row.promptTokens ?? undefined,
    completionTokens: row.completionTokens ?? undefined,
    totalTokens: row.totalTokens ?? undefined,
    cached: true,
  };
}

function deleteCachedResponse(key: string): void {
  getResponseCacheDb().prepare("DELETE FROM llm_response_cache WHERE cache_key = ?").run(key);
}

function pruneResponseCache(maxEntries: number, ttlSeconds: number): void {
  const db = getResponseCacheDb();
  if (maxEntries <= 0) {
    db.prepare("DELETE FROM llm_response_cache").run();
    return;
  }

  const now = Date.now();
  if (ttlSeconds > 0) {
    db.prepare("DELETE FROM llm_response_cache WHERE created_at_ms <= ?").run(now - ttlSeconds * 1000);
  }

  const countRow = db.prepare("SELECT COUNT(*) AS count FROM llm_response_cache").get() as { count: number };
  const excess = countRow.count - maxEntries;
  if (excess <= 0) return;
  db.prepare(
    `DELETE FROM llm_response_cache
     WHERE cache_key IN (
       SELECT cache_key
       FROM llm_response_cache
       ORDER BY accessed_at_ms ASC
       LIMIT ?
     )`,
  ).run(excess);
}

function setCachedResponse(key: string, result: Omit<ChatResult, "cached">, maxEntries: number, ttlSeconds: number): void {
  if (maxEntries <= 0) return;
  const db = getResponseCacheDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO llm_response_cache (
       cache_key,
       content,
       prompt_tokens,
       completion_tokens,
       total_tokens,
       created_at_ms,
       accessed_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       content = excluded.content,
       prompt_tokens = excluded.prompt_tokens,
       completion_tokens = excluded.completion_tokens,
       total_tokens = excluded.total_tokens,
       created_at_ms = excluded.created_at_ms,
       accessed_at_ms = excluded.accessed_at_ms`,
  ).run(
    key,
    result.content,
    result.promptTokens ?? null,
    result.completionTokens ?? null,
    result.totalTokens ?? null,
    now,
    now,
  );
  pruneResponseCache(maxEntries, ttlSeconds);
}

function responseCacheKey(input: {
  baseUrl: string;
  body: Record<string, unknown>;
}): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ schema: "daio.llm.response-cache.v1", baseUrl: input.baseUrl, body: input.body }))
    .digest("hex");
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function retryableChatError(err: unknown): boolean {
  const message = formatError(err);
  return (
    !message.includes("LLM_BASE_URL or OPENAI_API_KEY not configured") &&
    !message.includes("prompt-cache format requires exactly two messages")
  );
}

function retryIntegerEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryMessages(messages: ChatMessage[], reason: string): ChatMessage[] {
  const promptCacheMessages = assertPromptCacheMessages(messages);
  const system = promptCacheMessages[0]!;
  const user = promptCacheMessages[1]!;
  const safeReason = reason.replace(/\s+/g, " ").slice(0, 500);
  return buildPromptCacheMessages(
    system.content,
    `${user.content}\n\nRetry instruction: the previous LLM response was rejected (${safeReason}). Return ONLY valid JSON in the message content. Do not put the JSON in reasoning_content, tool_calls, markdown fences, or prose.`,
  );
}

function firstConfiguredEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function isOpenAiApiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch (_err) {
    return false;
  }
}

function configuredBaseUrl(options: ChatOptions): string {
  if (options.baseUrl?.trim()) return options.baseUrl.trim();
  const openAiBaseUrl = firstConfiguredEnv("OPENAI_BASE_URL");
  if (openAiBaseUrl) return openAiBaseUrl;
  if (firstConfiguredEnv("OPENAI_API_KEY")) return OPENAI_API_BASE_URL;
  const llmBaseUrl = firstConfiguredEnv("LLM_BASE_URL");
  if (llmBaseUrl) return llmBaseUrl;
  throw new Error("LLM_BASE_URL or OPENAI_API_KEY not configured");
}

export function configuredModelName(options: Pick<ChatOptions, "model"> = {}): string {
  if (options.model?.trim()) return options.model.trim();
  return firstConfiguredEnv("OPENAI_MODEL", "LLM_MODEL") ?? DEFAULT_LOCAL_LLM_MODEL;
}

function chatHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = firstConfiguredEnv("OPENAI_API_KEY", "LLM_API_KEY");
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const organization = firstConfiguredEnv("OPENAI_ORG_ID");
  if (organization) headers["OpenAI-Organization"] = organization;
  const project = firstConfiguredEnv("OPENAI_PROJECT_ID");
  if (project) headers["OpenAI-Project"] = project;
  return headers;
}

function derivedPromptCacheKey(model: string, messages: ChatMessage[]): string {
  const promptCacheMessages = assertPromptCacheMessages(messages);
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      schema: "daio.openai.prompt-cache-key.v1",
      model,
      systemPrefix: promptCacheMessages[0]!.content,
    }))
    .digest("hex")
    .slice(0, 32);
  return `daio-${digest}`;
}

function configuredPromptCacheKey(model: string, messages: ChatMessage[], options: ChatOptions): string | undefined {
  if (options.promptCacheKey !== undefined) {
    const value = options.promptCacheKey?.trim();
    return value || undefined;
  }
  const explicit = firstConfiguredEnv("OPENAI_PROMPT_CACHE_KEY", "LLM_PROMPT_CACHE_KEY");
  return explicit ?? derivedPromptCacheKey(model, messages);
}

function configuredPromptCacheRetention(options: ChatOptions): string | undefined {
  const raw =
    options.promptCacheRetention !== undefined
      ? options.promptCacheRetention
      : firstConfiguredEnv("OPENAI_PROMPT_CACHE_RETENTION", "LLM_PROMPT_CACHE_RETENTION");
  const value = raw?.trim();
  if (!value) return undefined;
  if (!PROMPT_CACHE_RETENTION_VALUES.has(value)) {
    throw new Error("prompt cache retention must be one of: in_memory, 24h");
  }
  return value;
}

function configuredReasoningEffort(options: ChatOptions, useOpenAiChatCompletions: boolean): string | null | undefined {
  if (options.reasoningEffort !== undefined) return options.reasoningEffort;
  const envReasoningEffort = firstConfiguredEnv("LLM_REASONING_EFFORT", "OPENAI_REASONING_EFFORT");
  if (envReasoningEffort !== undefined) return envReasoningEffort;
  return useOpenAiChatCompletions ? undefined : "low";
}

export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
  const baseUrl = configuredBaseUrl(options);
  const model = configuredModelName(options);
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const useOpenAiChatCompletions = isOpenAiApiBaseUrl(normalizedBaseUrl);
  const promptCacheMessages = assertPromptCacheMessages(messages);
  const timeoutMs = options.timeoutMs ?? Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
  const maxTokens = options.maxTokens ?? Number(process.env.LLM_MAX_TOKENS ?? 2_048);
  const envTemperature =
    process.env.LLM_TEMPERATURE !== undefined && process.env.LLM_TEMPERATURE !== ""
      ? Number(process.env.LLM_TEMPERATURE)
      : undefined;
  const temperature =
    options.temperature ?? (Number.isFinite(envTemperature) ? (envTemperature as number) : 0);

  const body: Record<string, unknown> = {
    model,
    messages: promptCacheMessages,
  };
  body[useOpenAiChatCompletions ? "max_completion_tokens" : "max_tokens"] = maxTokens;
  // Newer OpenAI GPT/reasoning snapshots reject non-default temperature values;
  // keep temperature for compatible local endpoints where agents use it for variance.
  if (!useOpenAiChatCompletions) {
    body.temperature = temperature;
  }
  if (options.responseFormatJson !== false) {
    body.response_format = { type: "json_object" };
  }
  // OpenAI GPT/reasoning models use their default reasoning level when this is
  // omitted; compatible local endpoints keep the historical low-effort default.
  const reasoningEffort = configuredReasoningEffort(options, useOpenAiChatCompletions);
  if (typeof reasoningEffort === "string" && reasoningEffort.trim() !== "") {
    body.reasoning_effort = reasoningEffort;
  }
  if (useOpenAiChatCompletions) {
    const promptCacheKey = configuredPromptCacheKey(model, promptCacheMessages, options);
    if (promptCacheKey) body.prompt_cache_key = promptCacheKey;
    const promptCacheRetention = configuredPromptCacheRetention(options);
    if (promptCacheRetention) body.prompt_cache_retention = promptCacheRetention;
  }

  const cacheEnabled = options.responseCache !== false;
  const cacheTtlSeconds = responseCacheTtlSeconds(options);
  const cacheMaxEntries = responseCacheMaxEntries(options);
  const cacheKey = responseCacheKey({ baseUrl: normalizedBaseUrl, body });
  if (cacheEnabled && cacheMaxEntries > 0) {
    const cached = getCachedResponse(cacheKey, cacheTtlSeconds);
    if (cached) {
      try {
        options.validateContent?.(cached.content);
        return cached;
      } catch (_err) {
        deleteCachedResponse(cacheKey);
      }
    }
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      method: "POST",
      headers: chatHeaders(),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`llm chat http ${res.status}: ${text.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`llm chat returned empty content: ${JSON.stringify(json).slice(0, 500)}`);
  }
  const result = {
    content,
    promptTokens: json.usage?.prompt_tokens,
    promptCachedTokens: json.usage?.prompt_tokens_details?.cached_tokens,
    completionTokens: json.usage?.completion_tokens,
    totalTokens: json.usage?.total_tokens,
  };
  options.validateContent?.(content);
  if (cacheEnabled) setCachedResponse(cacheKey, result, cacheMaxEntries, cacheTtlSeconds);
  return result;
}

export async function chatJsonWithRetry<T>(
  messages: ChatMessage[],
  options: ChatJsonRetryOptions<T>,
): Promise<ChatJsonRetryResult<T>> {
  const maxAttempts = options.maxAttempts ?? retryIntegerEnv("LLM_RETRY_ATTEMPTS", DEFAULT_LLM_RETRY_ATTEMPTS, 1);
  const retryBaseMs = options.retryBaseMs ?? retryIntegerEnv("LLM_RETRY_BASE_MS", DEFAULT_LLM_RETRY_BASE_MS, 0);
  const retryMaxMs = options.retryMaxMs ?? retryIntegerEnv("LLM_RETRY_MAX_MS", DEFAULT_LLM_RETRY_MAX_MS, 0);
  const retryErrors: string[] = [];
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let parsed: T | undefined;
    const validateContent = (content: string): void => {
      parsed = options.parse(extractJson(content));
    };
    const { parse, maxAttempts: _maxAttempts, retryBaseMs: _retryBaseMs, retryMaxMs: _retryMaxMs, log: _log, ...chatOptions } =
      options;
    try {
      const llm = await chat(attempt === 1 ? messages : retryMessages(messages, formatError(lastErr)), {
        ...chatOptions,
        validateContent,
        reasoningEffort:
          attempt > 1 && chatOptions.reasoningEffort === undefined ? "" : chatOptions.reasoningEffort,
      });
      return {
        llm,
        data: parsed ?? parse(extractJson(llm.content)),
        attempts: attempt,
        retryErrors,
      };
    } catch (err) {
      lastErr = err;
      const message = formatError(err);
      retryErrors.push(message);
      if (attempt >= maxAttempts || !retryableChatError(err)) break;
      const backoffMs =
        retryMaxMs === 0 ? retryBaseMs * attempt : Math.min(retryMaxMs, retryBaseMs * attempt);
      options.log?.(`LLM response rejected on attempt ${attempt}/${maxAttempts}: ${message}; retrying in ${backoffMs}ms`);
      if (backoffMs > 0) await delay(backoffMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(formatError(lastErr));
}

export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  // strip ```json fences if model added them despite json_object mode
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenceMatch ? fenceMatch[1] : trimmed;
  return JSON.parse(candidate!);
}
