import { EventEmitter } from "node:events";
import type { Contract, EventLog, Provider } from "ethers";
import { RequestStatus } from "../../shared/types.js";

export interface PhaseChange {
  requestId: bigint;
  status: RequestStatus;
  blockNumber: number;
  txHash: string;
  logIndex: number;
}

export interface ReviewReveal {
  requestId: bigint;
  reviewer: string;
  proposalScore: number;
  reportHash: string;
  reportURI: string;
  blockNumber: number;
  logIndex: number;
}

export interface FinalizedEvent {
  requestId: bigint;
  finalProposalScore: bigint;
  confidence: bigint;
  lowConfidence: boolean;
}

export class CoreEventStream extends EventEmitter {
  private readonly provider: Provider;
  private readonly core: Contract;
  private polling = false;
  private lastBlock = 0;
  private pollHandle: NodeJS.Timeout | null = null;
  private readonly phases: Map<string, PhaseChange[]> = new Map();
  private readonly reveals: Map<string, ReviewReveal[]> = new Map();

  constructor(provider: Provider, core: Contract) {
    super();
    this.provider = provider;
    this.core = core;
  }

  async start(fromBlock?: number, intervalMs = 500): Promise<void> {
    this.lastBlock = fromBlock ?? (await this.provider.getBlockNumber());
    this.polling = true;
    const tick = async () => {
      if (!this.polling) return;
      try {
        await this.poll();
      } catch (err) {
        this.emit("error", err);
      } finally {
        if (this.polling) this.pollHandle = setTimeout(tick, intervalMs);
      }
    };
    this.pollHandle = setTimeout(tick, intervalMs);
  }

  stop(): void {
    this.polling = false;
    if (this.pollHandle) clearTimeout(this.pollHandle);
    this.pollHandle = null;
    this.removeAllListeners();
  }

  private async poll(): Promise<void> {
    const head = await this.provider.getBlockNumber();
    if (head <= this.lastBlock) return;
    const from = this.lastBlock + 1;
    const to = head;
    // ethers v6 filters are dynamic ABI accessors; cast through unknown for typing.
    const f = (this.core as unknown as { filters: Record<string, () => unknown> }).filters;
    const [statusLogs, revealLogs, finalLogs] = await Promise.all([
      this.core.queryFilter(f.StatusChanged!() as never, from, to),
      this.core.queryFilter(f.ReviewRevealed!() as never, from, to),
      this.core.queryFilter(f.RequestFinalized!() as never, from, to),
    ]);

    // Merge and process in chronological order so that, e.g., a ReviewRevealed
    // landing in the same block as a StatusChanged(AuditCommit) is recorded
    // before any AuditCommit listener runs.
    type Entry =
      | { kind: "status"; log: EventLog }
      | { kind: "reveal"; log: EventLog }
      | { kind: "final"; log: EventLog };
    const all: Entry[] = [
      ...statusLogs.map((log) => ({ kind: "status" as const, log: log as EventLog })),
      ...revealLogs.map((log) => ({ kind: "reveal" as const, log: log as EventLog })),
      ...finalLogs.map((log) => ({ kind: "final" as const, log: log as EventLog })),
    ];
    all.sort((a, b) => a.log.blockNumber - b.log.blockNumber || a.log.index - b.log.index);

    for (const entry of all) {
      if (entry.kind === "status") {
        const evt = entry.log;
        const requestId = evt.args[0] as bigint;
        const statusRaw = evt.args[1] as bigint | number;
        const status = Number(statusRaw) as RequestStatus;
        const change: PhaseChange = {
          requestId,
          status,
          blockNumber: evt.blockNumber,
          txHash: evt.transactionHash,
          logIndex: evt.index,
        };
        const key = requestId.toString();
        const arr = this.phases.get(key) ?? [];
        arr.push(change);
        this.phases.set(key, arr);
        this.emit("status", change);
      } else if (entry.kind === "reveal") {
        const evt = entry.log;
        const requestId = evt.args[0] as bigint;
        const reveal: ReviewReveal = {
          requestId,
          reviewer: String(evt.args[1]),
          proposalScore: Number(evt.args[2]),
          reportHash: String(evt.args[3]),
          reportURI: String(evt.args[4]),
          blockNumber: evt.blockNumber,
          logIndex: evt.index,
        };
        const key = requestId.toString();
        const arr = this.reveals.get(key) ?? [];
        arr.push(reveal);
        this.reveals.set(key, arr);
        this.emit("review-revealed", reveal);
      } else {
        const evt = entry.log;
        const finalEvt: FinalizedEvent = {
          requestId: evt.args[0] as bigint,
          finalProposalScore: evt.args[1] as bigint,
          confidence: evt.args[2] as bigint,
          lowConfidence: Boolean(evt.args[3]),
        };
        this.emit("finalized", finalEvt);
      }
    }
    this.lastBlock = to;
  }

  phaseStartBlock(requestId: bigint, status: RequestStatus): number | undefined {
    const arr = this.phases.get(requestId.toString()) ?? [];
    for (let i = arr.length - 1; i >= 0; i--) {
      const item = arr[i];
      if (item && item.status === status) return item.blockNumber;
    }
    return undefined;
  }

  revealedReviewersOrdered(requestId: bigint): ReviewReveal[] {
    const arr = (this.reveals.get(requestId.toString()) ?? []).slice();
    arr.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return arr;
  }
}
