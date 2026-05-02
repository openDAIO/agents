import {
  ContentServiceClient,
  isContentServiceNotFound,
  type RequestDocumentRecord,
} from "../../shared/content-client.js";

export interface DocumentWaitOptions {
  waitMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  log?: (msg: string) => void;
  onWaiting?: (info: { elapsedMs: number; nextRetryMs: number }) => Promise<void>;
  shouldContinue?: () => boolean | Promise<boolean>;
}

export class RequestDocumentUnavailableError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly waitedMs: number,
  ) {
    super(`request document unavailable after ${waitedMs}ms for request ${requestId}`);
    this.name = "RequestDocumentUnavailableError";
  }
}

export class RequestDocumentWaitAbortedError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly waitedMs: number,
  ) {
    super(`request document wait aborted after ${waitedMs}ms for request ${requestId}`);
    this.name = "RequestDocumentWaitAbortedError";
  }
}

function integerEnv(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function documentWaitOptionsFromEnv(): Required<Pick<DocumentWaitOptions, "waitMs" | "retryInitialMs" | "retryMaxMs">> {
  const retryInitialMs = integerEnv("DAIO_DOCUMENT_RETRY_INITIAL_MS", 1_000, 1);
  return {
    waitMs: integerEnv("DAIO_DOCUMENT_WAIT_MS", 300_000, 0),
    retryInitialMs,
    retryMaxMs: Math.max(retryInitialMs, integerEnv("DAIO_DOCUMENT_RETRY_MAX_MS", 10_000, 1)),
  };
}

export async function waitForRequestDocument(
  content: ContentServiceClient,
  requestId: bigint,
  options: DocumentWaitOptions = {},
): Promise<RequestDocumentRecord> {
  const env = documentWaitOptionsFromEnv();
  const waitMs = options.waitMs ?? env.waitMs;
  const retryInitialMs = options.retryInitialMs ?? env.retryInitialMs;
  const retryMaxMs = Math.max(retryInitialMs, options.retryMaxMs ?? env.retryMaxMs);
  const startedAt = Date.now();
  let retryMs = retryInitialMs;
  let announced = false;

  for (;;) {
    try {
      return await content.getRequestDocument(requestId);
    } catch (err) {
      if (!isContentServiceNotFound(err, "getRequestDocument")) throw err;
      const elapsedMs = Date.now() - startedAt;
      const remainingMs = waitMs - elapsedMs;
      if (remainingMs <= 0) {
        throw new RequestDocumentUnavailableError(requestId.toString(), elapsedMs);
      }
      const nextRetryMs = Math.min(retryMs, remainingMs);
      if (options.shouldContinue && !(await options.shouldContinue())) {
        throw new RequestDocumentWaitAbortedError(requestId.toString(), elapsedMs);
      }
      if (!announced) {
        options.log?.(`request ${requestId} document not registered yet; waiting up to ${waitMs}ms`);
        announced = true;
      }
      await options.onWaiting?.({ elapsedMs, nextRetryMs });
      await delay(nextRetryMs);
      retryMs = Math.min(retryMs * 2, retryMaxMs);
    }
  }
}
