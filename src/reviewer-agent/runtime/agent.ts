import { NonceManager, type Wallet } from "ethers";
import type { ContractHandles } from "../chain/contracts.js";
import { CoreEventStream, type PhaseChange } from "../chain/events.js";
import { RequestStatus } from "../../shared/types.js";
import { ContentServiceClient } from "../../shared/content-client.js";
import { runReview, runReviewReveal, type ReviewFlowDeps } from "./reviewFlow.js";
import { runAudit, runAuditReveal, type AuditFlowDeps } from "./auditFlow.js";
import type { StateStore } from "./state.js";
import type { JsonRpcProvider } from "ethers";
import { SerialQueue } from "./serialQueue.js";

export interface AgentConfig {
  finalityFactor: bigint;
  reviewElectionDifficulty: bigint;
  auditElectionDifficulty: bigint;
  auditTargetLimit: bigint;
  autoStartRequests?: boolean;
  startRequestsMaxPerTick?: number;
  startRequestsMinIntervalMs?: number;
  startRequestsJitterMs?: number;
  publicKey: [bigint, bigint];
  proof: [bigint, bigint, bigint, bigint];
  label: string;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function expectedQueueStartError(err: unknown): boolean {
  const shaped = err as {
    errorName?: string;
    shortMessage?: string;
    message?: string;
    revert?: { name?: string };
  };
  const name = shaped.errorName ?? shaped.revert?.name ?? "";
  const message = shaped.shortMessage ?? shaped.message ?? String(err);
  return (
    name === "QueueEmpty" ||
    name === "BadConfig" ||
    message.includes("QueueEmpty") ||
    message.includes("BadConfig")
  );
}

export class ReviewerAgent {
  private events: CoreEventStream;
  private phaseQueues = new Map<string, Promise<void>>();
  private txQueue = new SerialQueue();
  private txSigner: NonceManager;
  private refillTimer: NodeJS.Timeout | null = null;
  private refillInFlight: Promise<void> | null = null;
  private refillRequested = false;
  private lastRefillAt = 0;

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly wallet: Wallet,
    private readonly handles: ContractHandles,
    private readonly content: ContentServiceClient,
    private readonly state: StateStore,
    private readonly cfg: AgentConfig,
  ) {
    this.events = new CoreEventStream(provider, handles.rawCore);
    this.txSigner = new NonceManager(wallet);
  }

  private log(msg: string): void {
    process.stdout.write(`[agent ${this.cfg.label} ${this.wallet.address.slice(0, 10)}] ${msg}\n`);
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
      await this.content.putAgentStatus({
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
      });
    } catch (err) {
      this.log(`status update failed: ${(err as Error).message}`);
    }
  }

  async start(): Promise<void> {
    this.events.on("error", (err) => this.log(`event error: ${err}`));
    this.events.on("status", (e) => {
      void this.handlePhaseChange(e as PhaseChange);
    });
    await this.events.start();
    this.log(`started; watching events`);
    this.scheduleActiveRefill("startup");
  }

  stop(): void {
    if (this.refillTimer) {
      clearTimeout(this.refillTimer);
      this.refillTimer = null;
    }
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
    if (this.cfg.autoStartRequests === false) return;
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

    const core = this.handles.core.connect(this.txSigner);
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
      try {
        await core.startNextRequest.staticCall();
      } catch (err) {
        if (!expectedQueueStartError(err)) {
          this.log(`keeper startNextRequest preflight failed: ${formatError(err)}`);
        }
        break;
      }

      try {
        const receipt = await this.txQueue.run(async () => {
          const tx = await core.startNextRequest();
          return tx.wait();
        });
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

  private async dispatch(change: PhaseChange): Promise<void> {
    const phase = RequestStatus[change.status] ?? `Status${change.status}`;
    const reviewDeps: ReviewFlowDeps = {
      handles: this.handles,
      events: this.events,
      content: this.content,
      state: this.state,
      wallet: this.wallet,
      txSigner: this.txSigner,
      publicKey: this.cfg.publicKey,
      proof: this.cfg.proof,
      log: (m) => this.log(m),
      txQueue: (task) => this.txQueue.run(task),
    };
    const auditDeps: AuditFlowDeps = reviewDeps;

    try {
      switch (change.status) {
        case RequestStatus.ReviewCommit: {
          await this.recordStatus(change.requestId, phase, "running", "phase event received");
          const res = await runReview(
            reviewDeps,
            change.requestId,
            this.cfg.finalityFactor,
            this.cfg.reviewElectionDifficulty,
          );
          if (!res.committed) {
            this.log(`review skip: ${res.reason}`);
            await this.recordStatus(change.requestId, phase, "skipped", res.reason);
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
          const res = await runAudit(
            auditDeps,
            change.requestId,
            this.cfg.finalityFactor,
            this.cfg.auditElectionDifficulty,
            this.cfg.auditTargetLimit,
          );
          if (!res.committed) {
            this.log(`audit skip: ${res.reason}`);
            await this.recordStatus(change.requestId, phase, "skipped", res.reason);
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
}
