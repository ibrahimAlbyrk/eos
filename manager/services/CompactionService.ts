// CompactionService — when to compact, and one run per worker at a time.
//
//   * auto: rides the daemon's IDLE edge (queue drain "empty"), ahead of the goal
//     loop / report-gap / threshold watchers — a worker at or over the configured
//     threshold is compacted before anything dispatches it more work.
//   * manual: the /compact slash command.
//
// The work itself is the core CompactContext use-case (injected as `run`). An
// auto run that failed is not retried at the same occupancy — only after a new
// turn has moved the context — so a broken summarizer can't hot-loop at IDLE.
// Config is read live (enabled / threshold follow Settings without a restart).

import type { WorkerRepo } from "../../core/src/ports/WorkerRepo.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";
import type { CompactContextInput, CompactContextResult } from "../../core/src/use-cases/CompactContext.ts";
import { isCompactionDue } from "../../core/src/domain/compaction.ts";

export interface CompactionServiceDeps {
  workers: Pick<WorkerRepo, "findById">;
  config(): { enabled: boolean; threshold: number };
  contextWindowFor(model: string | null | undefined): number | null;
  /** True when the worker's live session supports compaction (capability gate). */
  canCompact(workerId: string, backendKind: string | null): boolean;
  run(input: CompactContextInput): Promise<CompactContextResult>;
  log: Logger;
}

const isIdle = (state: unknown): boolean => String(state).toUpperCase() === "IDLE";

export class CompactionService {
  private readonly deps: CompactionServiceDeps;
  private readonly running = new Set<string>();
  private readonly failedAt = new Map<string, number>();

  constructor(deps: CompactionServiceDeps) {
    this.deps = deps;
  }

  /** True only while the compaction holds the worker in WORKING — the moment it
   *  settles to IDLE, queued messages must drain normally. */
  isCompacting(workerId: string): boolean {
    if (!this.running.has(workerId)) return false;
    return String(this.deps.workers.findById(workerId)?.state).toUpperCase() === "WORKING";
  }

  /** Starts an auto compaction when due. true = started (the caller should leave
   *  this IDLE edge alone; the next one arrives when the compaction settles). */
  checkOnIdle(workerId: string): boolean {
    if (this.running.has(workerId)) return false;
    const w = this.deps.workers.findById(workerId);
    if (!w || !isIdle(w.state)) return false;
    const used = w.last_context_tokens ?? 0;
    if (this.failedAt.get(workerId) === used) return false;
    const { enabled, threshold } = this.deps.config();
    if (!isCompactionDue({ enabled, threshold, used, limit: this.deps.contextWindowFor(w.model) })) return false;
    if (!this.deps.canCompact(workerId, w.backend_kind ?? null)) return false;
    this.launch({ workerId, trigger: "auto" }, used);
    return true;
  }

  /** /compact. Manual runs ignore `enabled` and the threshold — asked for is asked for. */
  start(workerId: string, instructions: string): { ok: boolean; reason?: string } {
    if (this.running.has(workerId)) return { ok: false, reason: "a compaction is already running" };
    const w = this.deps.workers.findById(workerId);
    if (!w) return { ok: false, reason: "worker not found" };
    if (!isIdle(w.state)) return { ok: false, reason: "the agent is busy" };
    if (!this.deps.canCompact(workerId, w.backend_kind ?? null)) return { ok: false, reason: "this agent cannot be compacted" };
    this.launch({ workerId, trigger: "manual", ...(instructions ? { instructions } : {}) }, w.last_context_tokens ?? 0);
    return { ok: true };
  }

  private launch(input: CompactContextInput, usedAtStart: number): void {
    const { workerId } = input;
    this.running.add(workerId);
    void this.deps.run(input)
      .then((r) => {
        if (r.ok) this.failedAt.delete(workerId);
        else if (input.trigger === "auto") this.failedAt.set(workerId, usedAtStart);
      })
      .catch((e) => this.deps.log.warn("compaction run crashed", { workerId, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => this.running.delete(workerId));
  }
}
