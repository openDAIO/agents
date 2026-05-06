import { NonceManager, type Wallet } from "ethers";
import type { ContractHandles } from "../chain/contracts.js";
import { CoreEventStream, type PhaseChange } from "../chain/events.js";
import { RequestStatus } from "../../shared/types.js";
import { ContentServiceClient } from "../../shared/content-client.js";
import { agentStatusMessage } from "../../shared/agent-signing.js";
import { runReview, runReviewReveal, type ReviewFlowDeps } from "./reviewFlow.js";
import { runAudit, runAuditReveal, type AuditFlowDeps } from "./auditFlow.js";
import type { StateStore } from "./state.js";
import type { Provider } from "ethers";
import { SerialQueue } from "./serialQueue.js";
import {
  txFeeOverridesFromEnv,
  txFinalityConfirmationsFromEnv,
  waitForTransactionWithRetries,
  withRpcReadRetries,
} from "../../shared/rpc.js";
import { gasLimitWithHeadroom } from "./gas.js";
import { readPhaseTiming } from "./phaseTiming.js";
import {
  resolveRequestRuntimeConfig,
  resolveTierRuntimeConfig,
  runtimeConfigSummary,
  type RuntimeConfig,
} from "./contractConfig.js";
import type { VrfProofProvider } from "../chain/vrfProof.js";

export interface AgentConfig {
  finalityFactor: bigint;
  reviewElectionDifficulty: bigint;
  auditElectionDifficulty: bigint;
  reviewCommitQuorum: bigint;
  auditCommitQuorum: bigint;
  auditTargetLimit: bigint;
  participationEnabled?: boolean;
  autoStartRequests?: boolean;
  eventPollIntervalMs?: number;
  eventLookbackBlocks?: number;
  eventReorgDepthBlocks?: number;
  eventFinalityConfirmations?: number;
  startRequestsMaxPerTick?: number;
  startRequestsMinIntervalMs?: number;
  startRequestsJitterMs?: number;
  keeperEnabled?: boolean;
  keeperReconcileIntervalMs?: number;
  keeperSyncActiveRequests?: boolean;
  keeperSyncMaxPerTick?: number;
  keeperWallet?: Wallet;
  vrf: VrfProofProvider;
  label: string;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
    for (const key of ["code", "errorName", "shortMessage", "message", "reason", "data", "info", "error", "revert"]) {
      visit(obj[key]);
    }
  };
  visit(err);
  return parts.join(" ");
}

function nonceError(err: unknown): boolean {
  const shaped = err as { code?: string };
  const text = deepErrorText(err);
  return (
    shaped.code === "NONCE_EXPIRED" ||
    text.includes("Nonce too low") ||
    text.includes("Nonce too high") ||
    text.includes("nonce has already been used")
  );
}

function expectedQueueStartError(err: unknown): boolean {
  const shaped = err as {
    errorName?: string;
    shortMessage?: string;
    message?: string;
    revert?: { name?: string };
  };
  const name = shaped.errorName ?? shaped.revert?.name ?? "";
  const message = `${shaped.shortMessage ?? ""} ${deepErrorText(err)}`;
  const expectedSelectors = [
    "0x75e52f4f", // QueueEmpty()
    "0x07cc321c", // BadConfig()
    "0x085de625", // TooEarly()
    "0x53c034cf", // TooManyActiveRequests()
  ];
  return (
    name === "QueueEmpty" ||
    name === "BadConfig" ||
    name === "TooEarly" ||
    expectedSelectors.some((selector) => message.includes(selector)) ||
    message.includes("QueueEmpty") ||
    message.includes("BadConfig") ||
    message.includes("TooEarly") ||
    message.includes("TooManyActiveRequests")
  );
}

export class ReviewerAgent {
  private events: CoreEventStream;
  private phaseQueues = new Map<string, Promise<void>>();
  private agentTxQueue = new SerialQueue();
  private keeperTxQueue = new SerialQueue();
  private agentTxSigner: NonceManager;
  private keeperTxSigner: NonceManager;
  private keeperUsesAgentSigner: boolean;
  private refillTimer: NodeJS.Timeout | null = null;
  private refillInFlight: Promise<void> | null = null;
  private refillRequested = false;
  private lastRefillAt = 0;
  private keeperReconcileTimer: NodeJS.Timeout | null = null;
  private readonly activeRequests = new Map<string, RequestStatus>();
  private readonly phaseRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly keeperSyncInFlight = new Set<string>();

  constructor(
    private readonly provider: Provider,
    private readonly wallet: Wallet,
    private readonly handles: ContractHandles,
    private readonly content: ContentServiceClient,
    private readonly state: StateStore,
    private readonly cfg: AgentConfig,
  ) {
    this.events = new CoreEventStream(provider, handles.rawCore, {
      cursorStore: {
        load: () => this.state.loadEventCursor(),
        save: (cursor) => this.state.saveEventCursor(cursor),
      },
      lookbackBlocks: cfg.eventLookbackBlocks,
      reorgDepthBlocks: cfg.eventReorgDepthBlocks,
      finalityConfirmations: cfg.eventFinalityConfirmations,
    });
    this.agentTxSigner = new NonceManager(wallet);
    const keeperWallet = cfg.keeperWallet;
    if (keeperWallet && keeperWallet.address.toLowerCase() !== wallet.address.toLowerCase()) {
      this.keeperUsesAgentSigner = false;
      this.keeperTxSigner = new NonceManager(keeperWallet);
    } else {
      this.keeperUsesAgentSigner = true;
      this.keeperTxSigner = this.agentTxSigner;
    }
  }

  private log(msg: string): void {
    process.stdout.write(`[agent ${this.cfg.label} ${this.wallet.address.slice(0, 10)}] ${msg}\n`);
  }

  private async queuedTxWith<T>(
    queue: SerialQueue,
    signer: NonceManager,
    queueLabel: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return queue.run(async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        signer.reset();
        try {
          return await task();
        } catch (err) {
          lastErr = err;
          if (!nonceError(err) || attempt === 2) throw err;
          this.log(`${queueLabel} nonce retry ${attempt + 1}/2: ${formatError(err)}`);
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      throw lastErr;
    });
  }

  private async queuedAgentTx<T>(task: () => Promise<T>): Promise<T> {
    return this.queuedTxWith(this.agentTxQueue, this.agentTxSigner, "agent tx", task);
  }

  private async queuedKeeperTx<T>(task: () => Promise<T>): Promise<T> {
    if (this.keeperUsesAgentSigner) return this.queuedAgentTx(task);
    return this.queuedTxWith(this.keeperTxQueue, this.keeperTxSigner, "keeper tx", task);
  }

  private async recordStatus(
    requestId: bigint,
    phase: string,
    status: string,
    detail?: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const safeDetail = detail && detail.length > 1000 ? `${detail.slice(0, 997)}...` : detail;
      const statusBody = {
        requestId,
        agent: this.wallet.address,
        phase,
        status,
        detail: safeDetail,
        payload: {
          label: this.cfg.label,
          chainStatus: phase,
          ...payload,
        },
      };
      const signature = await this.wallet.signMessage(
        agentStatusMessage({
          ...statusBody,
          requestId: requestId.toString(),
        }),
      );
      await this.content.putAgentStatus(statusBody, signature);
    } catch (err) {
      this.log(`status update failed: ${(err as Error).message}`);
    }
  }

  async start(): Promise<void> {
    this.events.on("error", (err) => this.log(`event error: ${err}`));
    this.events.on("status", (e) => {
      void this.handlePhaseChange(e as PhaseChange);
    });
    await this.logStartupChainConfig();
    await this.logKeeperSigner();
    const eventPollIntervalMs = Math.max(100, this.cfg.eventPollIntervalMs ?? 500);
    await this.events.start(undefined, eventPollIntervalMs);
    this.log(
      `started; watching events pollIntervalMs=${eventPollIntervalMs} finalityConfirmations=${this.cfg.eventFinalityConfirmations ?? txFinalityConfirmationsFromEnv()}`,
    );
    if (this.cfg.participationEnabled === false) {
      this.log("participation disabled; review/audit commits will be skipped");
    }
    this.scheduleActiveRefill("startup");
    this.scheduleKeeperReconcile();
  }

  stop(): void {
    if (this.refillTimer) {
      clearTimeout(this.refillTimer);
      this.refillTimer = null;
    }
    if (this.keeperReconcileTimer) {
      clearTimeout(this.keeperReconcileTimer);
      this.keeperReconcileTimer = null;
    }
    for (const timer of this.phaseRetryTimers.values()) clearTimeout(timer);
    this.phaseRetryTimers.clear();
    this.events.stop();
  }

  private async handlePhaseChange(change: PhaseChange): Promise<void> {
    this.maybeScheduleActiveRefill(change);
    const key = change.requestId.toString();
    const previous = this.phaseQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.dispatch(change));
    this.phaseQueues.set(key, next);
    try {
      await next;
    } finally {
      if (this.phaseQueues.get(key) === next) this.phaseQueues.delete(key);
    }
  }

  private maybeScheduleActiveRefill(change: PhaseChange): void {
    this.trackRequestStatus(change.requestId, change.status);
    switch (change.status) {
      case RequestStatus.Queued:
      case RequestStatus.Finalized:
      case RequestStatus.Cancelled:
      case RequestStatus.Failed:
      case RequestStatus.Unresolved:
        this.scheduleActiveRefill(RequestStatus[change.status] ?? `Status${change.status}`);
        break;
      default:
        break;
    }
  }

  private scheduleActiveRefill(reason: string): void {
    if (!this.keeperEnabled()) return;
    this.refillRequested = true;
    if (this.refillTimer || this.refillInFlight) return;

    const minInterval = Math.max(0, this.cfg.startRequestsMinIntervalMs ?? 1000);
    const jitterRange = Math.max(0, this.cfg.startRequestsJitterMs ?? 250);
    const jitter = jitterRange === 0 ? 0 : Math.floor(Math.random() * (jitterRange + 1));
    const elapsed = Date.now() - this.lastRefillAt;
    const delayMs = Math.max(0, minInterval - elapsed) + jitter;

    this.refillTimer = setTimeout(() => {
      this.refillTimer = null;
      const run = this.drainActiveRefills(reason);
      this.refillInFlight = run;
      run
        .catch((err) => this.log(`keeper refill failed: ${formatError(err)}`))
        .finally(() => {
          if (this.refillInFlight === run) this.refillInFlight = null;
          if (this.refillRequested) this.scheduleActiveRefill("pending");
        });
    }, delayMs);
  }

  private keeperEnabled(): boolean {
    return this.cfg.autoStartRequests !== false && this.cfg.keeperEnabled !== false;
  }

  private async logKeeperSigner(): Promise<void> {
    if (!this.keeperEnabled()) return;
    const keeperAddress = await this.keeperTxSigner.getAddress();
    if (this.keeperUsesAgentSigner) {
      this.log(`keeper enabled; using agent tx signer ${keeperAddress}`);
    } else {
      this.log(`keeper enabled; using dedicated keeper signer ${keeperAddress}`);
    }
  }

  private scheduleKeeperReconcile(): void {
    if (!this.keeperEnabled() || this.keeperReconcileTimer) return;
    const intervalMs = Math.max(0, this.cfg.keeperReconcileIntervalMs ?? 10_000);
    if (intervalMs === 0) return;
    this.keeperReconcileTimer = setTimeout(() => {
      this.keeperReconcileTimer = null;
      void this.syncTrackedActiveRequests("reconcile").catch((err) =>
        this.log(`keeper active sync failed: ${formatError(err)}`),
      );
      this.scheduleActiveRefill("reconcile");
      this.scheduleKeeperReconcile();
    }, intervalMs);
  }

  private trackRequestStatus(requestId: bigint, status: RequestStatus): void {
    const key = requestId.toString();
    if (this.activeStatus(status)) {
      this.activeRequests.set(key, status);
    } else if (
      status === RequestStatus.Queued ||
      status === RequestStatus.Finalized ||
      status === RequestStatus.Cancelled ||
      status === RequestStatus.Failed ||
      status === RequestStatus.Unresolved
    ) {
      this.activeRequests.delete(key);
      const retryTimer = this.phaseRetryTimers.get(key);
      if (retryTimer) {
        clearTimeout(retryTimer);
        this.phaseRetryTimers.delete(key);
      }
    }
  }

  private activeStatus(status: RequestStatus): boolean {
    return [
      RequestStatus.ReviewCommit,
      RequestStatus.ReviewReveal,
      RequestStatus.AuditCommit,
      RequestStatus.AuditReveal,
    ].includes(status);
  }

  private async drainActiveRefills(reason: string): Promise<void> {
    while (this.refillRequested) {
      this.refillRequested = false;
      this.lastRefillAt = Date.now();
      await this.refillActiveRequests(reason);
    }
  }

  private async refillActiveRequests(reason: string): Promise<void> {
    const maxPerTick = Math.max(0, Math.trunc(this.cfg.startRequestsMaxPerTick ?? 2));
    if (maxPerTick === 0) return;

    const core = this.handles.core.connect(this.keeperTxSigner);
    let attempts = maxPerTick;
    try {
      const maxActiveRaw = (await this.handles.core.maxActiveRequests()) as bigint;
      const maxActive =
        maxActiveRaw > BigInt(Number.MAX_SAFE_INTEGER)
          ? Number.MAX_SAFE_INTEGER
          : Number(maxActiveRaw);
      attempts = Math.min(attempts, maxActive);
    } catch (err) {
      this.log(`keeper could not read maxActiveRequests; using local limit: ${formatError(err)}`);
    }

    for (let i = 0; i < attempts; i++) {
      const queueSize = await this.keeperQueueSize("startNextRequest");
      if (queueSize === 0n) break;
      try {
        await core.startNextRequest.staticCall();
      } catch (err) {
        if (!expectedQueueStartError(err)) {
          this.log(`keeper startNextRequest preflight failed: ${formatError(err)}`);
        }
        break;
      }

      try {
        const receipt = await this.queuedKeeperTx(async () => {
          const queueSize = await this.keeperQueueSize("queued startNextRequest");
          if (queueSize === 0n) return undefined;
          try {
            await core.startNextRequest.staticCall();
          } catch (err) {
            if (expectedQueueStartError(err)) return undefined;
            throw err;
          }
          const gasLimit = await gasLimitWithHeadroom(
            core.startNextRequest,
            [],
            "DAIO_START_NEXT_REQUEST_GAS_FLOOR",
            300_000n,
          );
          const fees = await txFeeOverridesFromEnv(this.provider);
          const tx = await core.startNextRequest({ gasLimit, ...fees });
          return waitForTransactionWithRetries(tx);
        });
        if (receipt === undefined) break;
        if (!receipt || receipt.status !== 1) {
          throw new Error(`startNextRequest transaction reverted`);
        }
        this.log(
          `keeper started queued request reason=${reason} tx=${receipt.hash} block=${receipt.blockNumber}`,
        );
      } catch (err) {
        if (!expectedQueueStartError(err)) {
          this.log(`keeper startNextRequest failed: ${formatError(err)}`);
        }
        break;
      }
    }
  }

  private async keeperQueueSize(context: string): Promise<bigint | undefined> {
    try {
      const raw = await withRpcReadRetries(
        () => this.handles.priorityQueue.currentSize() as Promise<bigint>,
      );
      return BigInt(raw);
    } catch (err) {
      this.log(`keeper could not read queue size for ${context}; falling back to staticCall: ${formatError(err)}`);
      return undefined;
    }
  }

  private syncActiveRequestsEnabled(): boolean {
    return this.keeperEnabled() && this.cfg.keeperSyncActiveRequests !== false;
  }

  private async syncTrackedActiveRequests(reason: string): Promise<void> {
    if (!this.syncActiveRequestsEnabled() || this.activeRequests.size === 0) return;
    const maxPerTick = Math.max(0, Math.trunc(this.cfg.keeperSyncMaxPerTick ?? 8));
    if (maxPerTick === 0) return;
    const entries = [...this.activeRequests.entries()].slice(0, maxPerTick);
    for (const [requestIdRaw, knownStatus] of entries) {
      await this.syncActiveRequest(BigInt(requestIdRaw), knownStatus, reason);
    }
  }

  private async syncActiveRequest(requestId: bigint, knownStatus: RequestStatus, reason: string): Promise<void> {
    if (!this.syncActiveRequestsEnabled()) return;
    const key = requestId.toString();
    if (this.keeperSyncInFlight.has(key)) return;
    this.keeperSyncInFlight.add(key);
    try {
      const liveStatus = await this.currentRequestStatus(requestId);
      this.trackRequestStatus(requestId, liveStatus);
      if (!this.activeStatus(liveStatus)) {
        await this.recordLiveStatusForStaleEvent(requestId, liveStatus, RequestStatus[knownStatus] ?? `Status${knownStatus}`);
        return;
      }

      const core = this.handles.core.connect(this.keeperTxSigner);
      let predictedStatus: RequestStatus;
      try {
        predictedStatus = Number(await core.syncRequest.staticCall(requestId)) as RequestStatus;
      } catch (err) {
        this.log(`keeper syncRequest preflight failed request=${requestId}: ${formatError(err)}`);
        return;
      }
      if (predictedStatus === liveStatus) return;

      const result = await this.queuedKeeperTx(async () => {
        const queuedLiveStatus = await this.currentRequestStatus(requestId);
        this.trackRequestStatus(requestId, queuedLiveStatus);
        if (!this.activeStatus(queuedLiveStatus)) {
          await this.recordLiveStatusForStaleEvent(
            requestId,
            queuedLiveStatus,
            RequestStatus[knownStatus] ?? `Status${knownStatus}`,
          );
          return undefined;
        }

        let queuedPredictedStatus: RequestStatus;
        try {
          queuedPredictedStatus = Number(await core.syncRequest.staticCall(requestId)) as RequestStatus;
        } catch (err) {
          this.log(`keeper syncRequest queued preflight failed request=${requestId}: ${formatError(err)}`);
          return undefined;
        }
        if (queuedPredictedStatus === queuedLiveStatus) return undefined;

        const gasLimit = await gasLimitWithHeadroom(
          core.syncRequest,
          [requestId],
          "DAIO_SYNC_REQUEST_GAS_FLOOR",
          2_000_000n,
        );
        const fees = await txFeeOverridesFromEnv(this.provider);
        const tx = await core.syncRequest(requestId, { gasLimit, ...fees });
        const receipt = await waitForTransactionWithRetries(tx);
        return { receipt, liveStatus: queuedLiveStatus, predictedStatus: queuedPredictedStatus };
      });
      if (result === undefined) return;
      const { receipt, liveStatus: sentLiveStatus, predictedStatus: sentPredictedStatus } = result;
      if (!receipt || receipt.status !== 1) {
        throw new Error(`syncRequest transaction reverted for request ${requestId}`);
      }
      this.log(
        `keeper synced active request=${requestId} reason=${reason} ${RequestStatus[sentLiveStatus]}->${RequestStatus[sentPredictedStatus] ?? `Status${sentPredictedStatus}`} tx=${receipt.hash} block=${receipt.blockNumber}`,
      );
      this.trackRequestStatus(requestId, sentPredictedStatus);
      if (
        sentPredictedStatus === RequestStatus.Queued ||
        sentPredictedStatus === RequestStatus.Finalized ||
        sentPredictedStatus === RequestStatus.Cancelled ||
        sentPredictedStatus === RequestStatus.Failed ||
        sentPredictedStatus === RequestStatus.Unresolved
      ) {
        this.scheduleActiveRefill(`sync-${RequestStatus[sentPredictedStatus] ?? sentPredictedStatus}`);
      }
    } finally {
      this.keeperSyncInFlight.delete(key);
    }
  }

  private schedulePhaseRetry(change: PhaseChange, reason: string): void {
    if (!this.activeStatus(change.status)) return;
    const key = change.requestId.toString();
    if (this.phaseRetryTimers.has(key)) return;
    const retryMs = Math.max(1_000, this.integerEnv("DAIO_DOCUMENT_RECHECK_MS", 10_000, 1_000));
    const timer = setTimeout(() => {
      this.phaseRetryTimers.delete(key);
      void this.currentRequestStatus(change.requestId)
        .then((liveStatus) => {
          this.trackRequestStatus(change.requestId, liveStatus);
          if (liveStatus !== change.status) return;
          this.log(
            `retrying ${RequestStatus[change.status] ?? `Status${change.status}`} for request ${change.requestId} after ${reason}`,
          );
          void this.handlePhaseChange(change);
        })
        .catch((err) => {
          this.log(`phase retry status check failed request=${change.requestId}: ${formatError(err)}`);
          this.schedulePhaseRetry(change, reason);
        });
    }, retryMs);
    this.phaseRetryTimers.set(key, timer);
  }

  private integerEnv(name: string, fallback: number, min = 0): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === "") return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return parsed;
  }

  private minCommitTimeRemainingMs(): number {
    return this.integerEnv("DAIO_MIN_COMMIT_TIME_REMAINING_MS", 120_000, 0);
  }

  private fallbackRuntimeConfig(): RuntimeConfig {
    const fallbackPhaseTimeoutMs = this.integerEnv("DAIO_FALLBACK_PHASE_TIMEOUT_MS", 600_000, 0);
    return {
      finalityFactor: this.cfg.finalityFactor,
      reviewElectionDifficulty: this.cfg.reviewElectionDifficulty,
      auditElectionDifficulty: this.cfg.auditElectionDifficulty,
      reviewCommitQuorum: this.cfg.reviewCommitQuorum,
      auditCommitQuorum: this.cfg.auditCommitQuorum,
      auditTargetLimit: this.cfg.auditTargetLimit,
      reviewCommitTimeoutMs: fallbackPhaseTimeoutMs,
      reviewRevealTimeoutMs: fallbackPhaseTimeoutMs,
      auditCommitTimeoutMs: fallbackPhaseTimeoutMs,
      auditRevealTimeoutMs: fallbackPhaseTimeoutMs,
    };
  }

  private async documentWaitMsForPhase(change: PhaseChange, phaseTimeoutMs: number): Promise<number | undefined> {
    const timeoutMs = Math.max(0, Math.trunc(phaseTimeoutMs));
    if (timeoutMs === 0) return undefined;

    const startBlock = this.events.phaseStartBlock(change.requestId, change.status);

    try {
      const timing = await readPhaseTiming(this.provider, startBlock, timeoutMs);
      if (!timing) return undefined;
      this.log(
        `request ${change.requestId} ${RequestStatus[change.status] ?? `Status${change.status}`} document wait remaining=${timing.remainingMs}ms timeout=${timing.timeoutMs}ms elapsed=${timing.elapsedMs}ms`,
      );
      return timing.remainingMs;
    } catch (err) {
      this.log(`document wait phase timing read failed for request ${change.requestId}: ${formatError(err)}`);
      return timeoutMs;
    }
  }

  private async requestRuntimeConfig(requestId: bigint): Promise<RuntimeConfig> {
    const resolved = await resolveRequestRuntimeConfig(
      this.provider,
      this.handles,
      requestId,
      this.fallbackRuntimeConfig(),
    );
    const summary = runtimeConfigSummary(resolved.config);
    if (resolved.source === "contract-storage") {
      this.log(
        `request ${requestId} config from contract storage finality=${summary.finalityFactor} reviewDiff=${summary.reviewElectionDifficulty} auditDiff=${summary.auditElectionDifficulty} reviewCommitQuorum=${summary.reviewCommitQuorum} auditCommitQuorum=${summary.auditCommitQuorum} auditTargetLimit=${summary.auditTargetLimit} reviewCommitTimeoutMs=${summary.reviewCommitTimeoutMs} auditCommitTimeoutMs=${summary.auditCommitTimeoutMs}`,
      );
    } else {
      this.log(
        `request ${requestId} config fallback finality=${summary.finalityFactor} reviewDiff=${summary.reviewElectionDifficulty} auditDiff=${summary.auditElectionDifficulty} reviewCommitQuorum=${summary.reviewCommitQuorum} auditCommitQuorum=${summary.auditCommitQuorum} auditTargetLimit=${summary.auditTargetLimit} reviewCommitTimeoutMs=${summary.reviewCommitTimeoutMs} auditCommitTimeoutMs=${summary.auditCommitTimeoutMs}; read failed: ${resolved.error ?? "unknown"}`,
      );
    }
    return resolved.config;
  }

  private async logStartupChainConfig(): Promise<void> {
    const maxActive = await this.handles.core.maxActiveRequests().catch(() => undefined);
    if (maxActive !== undefined) {
      this.log(`chain maxActiveRequests=${maxActive.toString()}`);
    }

    for (const [tier, name] of ["Fast", "Standard", "Critical"].entries()) {
      const resolved = await resolveTierRuntimeConfig(
        this.provider,
        this.handles,
        BigInt(tier),
        this.fallbackRuntimeConfig(),
      );
      const summary = runtimeConfigSummary(resolved.config);
      if (resolved.source === "contract-storage") {
        this.log(
          `tier ${name} config from contract storage finality=${summary.finalityFactor} reviewDiff=${summary.reviewElectionDifficulty} auditDiff=${summary.auditElectionDifficulty} reviewCommitQuorum=${summary.reviewCommitQuorum} auditCommitQuorum=${summary.auditCommitQuorum} auditTargetLimit=${summary.auditTargetLimit} reviewCommitTimeoutMs=${summary.reviewCommitTimeoutMs} auditCommitTimeoutMs=${summary.auditCommitTimeoutMs}`,
        );
      } else {
        this.log(`tier ${name} config fallback; storage read failed: ${resolved.error ?? "unknown"}`);
        break;
      }
    }
  }

  private async dispatch(change: PhaseChange): Promise<void> {
    const phase = RequestStatus[change.status] ?? `Status${change.status}`;
    const reviewDeps: ReviewFlowDeps = {
      handles: this.handles,
      events: this.events,
      content: this.content,
      state: this.state,
      provider: this.provider,
      wallet: this.wallet,
      txSigner: this.agentTxSigner,
      vrf: this.cfg.vrf,
      log: (m) => this.log(m),
      txQueue: (task) => this.queuedAgentTx(task),
      recordStatus: (requestId, phaseName, status, detail, payload) =>
        this.recordStatus(requestId, phaseName, status, detail, payload),
    };
    const auditDeps: AuditFlowDeps = reviewDeps;

    try {
      if (this.shouldCheckLiveStatus(change.status)) {
        const liveStatus = await this.currentRequestStatus(change.requestId, change.blockNumber).catch((err) => {
          this.log(`could not read live status for request ${change.requestId}: ${formatError(err)}`);
          return undefined;
        });
        if (liveStatus !== undefined && liveStatus !== change.status) {
          await this.recordLiveStatusForStaleEvent(change.requestId, liveStatus, phase);
          return;
        }
      }

      switch (change.status) {
        case RequestStatus.ReviewCommit: {
          await this.recordStatus(change.requestId, phase, "running", "phase event received");
          const runtimeConfig = await this.requestRuntimeConfig(change.requestId);
          const documentWaitMs = await this.documentWaitMsForPhase(
            change,
            runtimeConfig.reviewCommitTimeoutMs,
          );
          const res = await runReview(
            reviewDeps,
            change.requestId,
            runtimeConfig.finalityFactor,
            runtimeConfig.reviewElectionDifficulty,
            {
              documentWaitMs,
              phaseTimeoutMs: runtimeConfig.reviewCommitTimeoutMs,
              minCommitTimeRemainingMs: this.minCommitTimeRemainingMs(),
              commitQuorum: runtimeConfig.reviewCommitQuorum,
              participationEnabled: this.cfg.participationEnabled !== false,
            },
          );
          if (!res.committed) {
            this.log(`review skip: ${res.reason}`);
            const status =
              res.reason === "document_unavailable"
                ? "document_unavailable"
                : res.reason === "too_late_for_commit"
                  ? "too_late_for_commit"
                  : "skipped";
            await this.recordStatus(change.requestId, phase, status, res.reason);
            if (res.reason === "document_unavailable") {
              this.schedulePhaseRetry(change, "document_unavailable");
              await this.syncActiveRequest(change.requestId, change.status, "document_unavailable").catch((err) =>
                this.log(`keeper document-timeout sync failed: ${formatError(err)}`),
              );
            } else if (res.reason === "document_wait_aborted") {
              const liveStatus = await this.currentRequestStatus(change.requestId).catch(() => undefined);
              if (liveStatus !== undefined) {
                await this.recordLiveStatusForStaleEvent(change.requestId, liveStatus, phase);
              }
            }
          } else {
            await this.recordStatus(change.requestId, phase, "committed", "review committed", {
              commitTx: res.commitTx,
              reportHash: res.reportHash,
              reportURI: res.reportURI,
            });
          }
          break;
        }
        case RequestStatus.ReviewReveal: {
          await this.recordStatus(change.requestId, phase, "running", "phase event received");
          const res = await runReviewReveal(reviewDeps, change.requestId);
          if (!res.revealed) {
            this.log(`review reveal skip: ${res.reason}`);
            await this.recordStatus(change.requestId, phase, "skipped", res.reason);
          } else {
            await this.recordStatus(change.requestId, phase, "revealed", "review revealed", {
              revealTx: res.revealTx,
            });
          }
          break;
        }
        case RequestStatus.AuditCommit: {
          await this.recordStatus(change.requestId, phase, "running", "phase event received");
          const runtimeConfig = await this.requestRuntimeConfig(change.requestId);
          const documentWaitMs = await this.documentWaitMsForPhase(
            change,
            runtimeConfig.auditCommitTimeoutMs,
          );
          const res = await runAudit(
            auditDeps,
            change.requestId,
            runtimeConfig.finalityFactor,
            runtimeConfig.auditElectionDifficulty,
            runtimeConfig.auditTargetLimit,
            {
              documentWaitMs,
              phaseTimeoutMs: runtimeConfig.auditCommitTimeoutMs,
              minCommitTimeRemainingMs: this.minCommitTimeRemainingMs(),
              commitQuorum: runtimeConfig.auditCommitQuorum,
              participationEnabled: this.cfg.participationEnabled !== false,
            },
          );
          if (!res.committed) {
            this.log(`audit skip: ${res.reason}`);
            const status =
              res.reason === "document_unavailable"
                ? "document_unavailable"
                : res.reason === "too_late_for_commit"
                  ? "too_late_for_commit"
                  : "skipped";
            await this.recordStatus(change.requestId, phase, status, res.reason);
            if (res.reason === "document_unavailable") {
              this.schedulePhaseRetry(change, "document_unavailable");
              await this.syncActiveRequest(change.requestId, change.status, "document_unavailable").catch((err) =>
                this.log(`keeper document-timeout sync failed: ${formatError(err)}`),
              );
            } else if (res.reason === "document_wait_aborted") {
              const liveStatus = await this.currentRequestStatus(change.requestId).catch(() => undefined);
              if (liveStatus !== undefined) {
                await this.recordLiveStatusForStaleEvent(change.requestId, liveStatus, phase);
              }
            }
          } else {
            await this.recordStatus(change.requestId, phase, "committed", "audit committed", {
              commitTx: res.commitTx,
              auditHash: res.auditHash,
              auditURI: res.auditURI,
            });
          }
          break;
        }
        case RequestStatus.AuditReveal: {
          await this.recordStatus(change.requestId, phase, "running", "phase event received");
          const res = await runAuditReveal(auditDeps, change.requestId);
          if (!res.revealed) {
            this.log(`audit reveal skip: ${res.reason}`);
            await this.recordStatus(change.requestId, phase, "skipped", res.reason);
          } else {
            await this.recordStatus(change.requestId, phase, "revealed", "audit revealed", {
              revealTx: res.revealTx,
            });
          }
          break;
        }
        case RequestStatus.Finalized:
          await this.recordStatus(change.requestId, phase, "finalized", "request finalized");
          break;
        case RequestStatus.Cancelled:
        case RequestStatus.Failed:
        case RequestStatus.Unresolved:
          await this.recordStatus(change.requestId, phase, "terminal", "request ended without finalization");
          break;
        default:
          await this.recordStatus(change.requestId, phase, "observed", "phase event received");
          break;
      }
    } catch (err) {
      this.log(`dispatch error in ${RequestStatus[change.status]}: ${(err as Error).message}`);
      await this.recordStatus(change.requestId, phase, "error", (err as Error).message);
    }
  }

  private async currentRequestStatus(requestId: bigint, blockTag?: number): Promise<RequestStatus> {
    const core = this.handles.core as unknown as {
      getRequestLifecycle(id: bigint, overrides?: { blockTag: number }): Promise<readonly unknown[]>;
    };
    const lifecycle = await withRpcReadRetries(() =>
      blockTag === undefined ? core.getRequestLifecycle(requestId) : core.getRequestLifecycle(requestId, { blockTag }),
    );
    return Number(lifecycle[1] as bigint | number) as RequestStatus;
  }

  private shouldCheckLiveStatus(status: RequestStatus): boolean {
    return [
      RequestStatus.ReviewCommit,
      RequestStatus.ReviewReveal,
      RequestStatus.AuditCommit,
      RequestStatus.AuditReveal,
    ].includes(status);
  }

  private async recordLiveStatusForStaleEvent(
    requestId: bigint,
    liveStatus: RequestStatus,
    stalePhase: string,
  ): Promise<void> {
    const livePhase = RequestStatus[liveStatus] ?? `Status${liveStatus}`;
    this.log(`skip stale ${stalePhase} event for request ${requestId}; live status is ${livePhase}`);
    switch (liveStatus) {
      case RequestStatus.Finalized:
        this.trackRequestStatus(requestId, liveStatus);
        await this.recordStatus(requestId, livePhase, "finalized", "request finalized");
        break;
      case RequestStatus.Cancelled:
      case RequestStatus.Failed:
      case RequestStatus.Unresolved:
        this.trackRequestStatus(requestId, liveStatus);
        await this.recordStatus(requestId, livePhase, "terminal", "request ended without finalization");
        break;
      default:
        this.trackRequestStatus(requestId, liveStatus);
        break;
    }
  }
}
