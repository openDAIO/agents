import type { Wallet } from "ethers";
import type { ContractHandles } from "../chain/contracts.js";
import { CoreEventStream, type PhaseChange } from "../chain/events.js";
import { RequestStatus } from "../../shared/types.js";
import { ContentServiceClient } from "../../shared/content-client.js";
import { runReview, runReviewReveal, type ReviewFlowDeps } from "./reviewFlow.js";
import { runAudit, runAuditReveal, type AuditFlowDeps } from "./auditFlow.js";
import type { StateStore } from "./state.js";
import type { JsonRpcProvider } from "ethers";

export interface AgentConfig {
  finalityFactor: bigint;
  reviewElectionDifficulty: bigint;
  auditElectionDifficulty: bigint;
  auditTargetLimit: bigint;
  publicKey: [bigint, bigint];
  proof: [bigint, bigint, bigint, bigint];
  label: string;
}

export class ReviewerAgent {
  private events: CoreEventStream;
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly wallet: Wallet,
    private readonly handles: ContractHandles,
    private readonly content: ContentServiceClient,
    private readonly state: StateStore,
    private readonly cfg: AgentConfig,
  ) {
    this.events = new CoreEventStream(provider, handles.rawCore);
  }

  private log(msg: string): void {
    process.stdout.write(`[agent ${this.cfg.label} ${this.wallet.address.slice(0, 10)}] ${msg}\n`);
  }

  async start(): Promise<void> {
    this.events.on("error", (err) => this.log(`event error: ${err}`));
    this.events.on("status", (e) => {
      void this.handlePhaseChange(e as PhaseChange);
    });
    await this.events.start();
    this.log(`started; watching events`);
  }

  stop(): void {
    this.events.stop();
  }

  private async handlePhaseChange(change: PhaseChange): Promise<void> {
    const key = `${change.requestId.toString()}:${change.status}`;
    if (this.inflight.has(key)) return;
    const p = this.dispatch(change).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    await p;
  }

  private async dispatch(change: PhaseChange): Promise<void> {
    const reviewDeps: ReviewFlowDeps = {
      handles: this.handles,
      events: this.events,
      content: this.content,
      state: this.state,
      wallet: this.wallet,
      publicKey: this.cfg.publicKey,
      proof: this.cfg.proof,
      log: (m) => this.log(m),
    };
    const auditDeps: AuditFlowDeps = reviewDeps;

    try {
      switch (change.status) {
        case RequestStatus.ReviewCommit: {
          const res = await runReview(
            reviewDeps,
            change.requestId,
            this.cfg.finalityFactor,
            this.cfg.reviewElectionDifficulty,
          );
          if (!res.committed) this.log(`review skip: ${res.reason}`);
          break;
        }
        case RequestStatus.ReviewReveal: {
          const res = await runReviewReveal(reviewDeps, change.requestId);
          if (!res.revealed) this.log(`review reveal skip: ${res.reason}`);
          break;
        }
        case RequestStatus.AuditCommit: {
          const res = await runAudit(
            auditDeps,
            change.requestId,
            this.cfg.finalityFactor,
            this.cfg.auditElectionDifficulty,
            this.cfg.auditTargetLimit,
          );
          if (!res.committed) this.log(`audit skip: ${res.reason}`);
          break;
        }
        case RequestStatus.AuditReveal: {
          const res = await runAuditReveal(auditDeps, change.requestId);
          if (!res.revealed) this.log(`audit reveal skip: ${res.reason}`);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      this.log(`dispatch error in ${RequestStatus[change.status]}: ${(err as Error).message}`);
    }
  }
}
