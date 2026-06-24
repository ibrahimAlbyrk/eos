// GoalLoopService — the IDLE goal-gate's re-entrancy guard + starvation order.
// The daemon calls loopTickFor(workerId) only from the queue-drain "empty"
// branch (so peer > queue > loop is already honored structurally); this service
// re-verifies those invariants itself (defense in depth) and serializes ticks
// per worker with an in-flight Set, mirroring drainFor/pumpPeerFor. The actual
// goal logic lives in the core runLoopTick use-case.

import { runLoopTick, type LoopTickOutcome } from "../../core/src/use-cases/runLoopTick.ts";
import type { LoopProgressSink } from "../../core/src/ports/LoopProgressSink.ts";
import type { LoopStateRepo } from "../../core/src/ports/LoopStateRepo.ts";
import type { LoopStatus, LoopCheckProgress, LoopCheckEvent } from "../../contracts/src/loop.ts";
import type { GoalCheckStrategy } from "../../core/src/ports/GoalCheckStrategy.ts";
import type { WorkerRepo } from "../../core/src/ports/WorkerRepo.ts";
import type { MessageQueueRepo } from "../../core/src/ports/MessageQueueRepo.ts";
import type { PromptRenderer } from "../../core/src/ports/PromptRenderer.ts";
import type { Clock } from "../../core/src/ports/Clock.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";

// The loop status to broadcast for each tick outcome (noop → nothing changed).
const STATUS_OF: Record<LoopTickOutcome, LoopStatus | null> = {
  noop: null,
  continued: "active",
  released: "passed",
  exhausted: "exhausted",
};

export interface GoalLoopDeps {
  workers: Pick<WorkerRepo, "findById">;
  loops: LoopStateRepo;
  messageQueue: Pick<MessageQueueRepo, "listPending">;
  // A queued (not-yet-delivered) peer consult addressed to this worker — non-null
  // means the peer pump owns the next turn, so the loop must yield.
  peerRequests: { nextQueuedFor(to: string): unknown };
  strategyFor(name: string): GoalCheckStrategy;
  dispatch(input: { workerId: string; text: string; origin: string }): Promise<unknown>;
  releaseReport(input: { workerId: string; parentId: string; text: string }): Promise<unknown>;
  stateHash(input: { worktreeDir?: string; forkBaseSha?: string }): Promise<string>;
  noProgressWindow: number;
  stopOnNoProgress: boolean;
  // Notify the UI of a loop lifecycle change (the daemon publishes loop:change).
  publishChange(workerId: string, status: LoopStatus): void;
  // Transient live goal-check progress (the daemon publishes "loop:check").
  publishCheck(progress: LoopCheckProgress): void;
  // Durable per-attempt verdict appended to the worker's timeline ("loop_check").
  recordCheck(workerId: string, event: LoopCheckEvent): void;
  renderer: PromptRenderer;
  isLive(workerId: string): boolean;
  clock: Clock;
  log: Logger;
}

export class GoalLoopService {
  private readonly ticking = new Set<string>();
  private readonly deps: GoalLoopDeps;

  constructor(deps: GoalLoopDeps) {
    this.deps = deps;
  }

  loopTickFor(workerId: string): void {
    if (this.ticking.has(workerId)) return;
    const w = this.deps.workers.findById(workerId);
    if (!w || String(w.state).toUpperCase() !== "IDLE") return;
    if (!this.deps.isLive(workerId)) return;
    if (!this.deps.loops.findActiveByWorker(workerId)) return;
    // Starvation order: a queued message or a waiting peer always precedes a
    // self-continue. (The daemon enforces this too; re-checked here.)
    if (this.deps.messageQueue.listPending(workerId).length > 0) return;
    if (this.deps.peerRequests.nextQueuedFor(workerId) != null) return;

    // Fan each tick phase to the UI (loop:check) and persist the verdict
    // (loop_check) — one sink, the same source for both the live indicator and
    // the durable history, so they can never disagree.
    const progress: LoopProgressSink = (u) => {
      this.deps.publishCheck({ workerId, ...u });
      if (u.phase === "verdict" && u.outcome) {
        this.deps.recordCheck(workerId, {
          attempt: u.attempt, maxAttempts: u.maxAttempts, strategy: u.strategy,
          met: u.met ?? false, outcome: u.outcome, reason: u.reason ?? "",
        });
      }
    };

    this.ticking.add(workerId);
    void (async () => {
      try {
        const outcome = await runLoopTick(
          {
            loops: this.deps.loops,
            strategyFor: this.deps.strategyFor,
            dispatch: this.deps.dispatch,
            releaseReport: this.deps.releaseReport,
            stateHash: this.deps.stateHash,
            noProgressWindow: this.deps.noProgressWindow,
            stopOnNoProgress: this.deps.stopOnNoProgress,
            renderer: this.deps.renderer,
            progress,
            clock: this.deps.clock,
            log: this.deps.log,
          },
          {
            workerId,
            worktreeDir: w.worktree_dir ?? undefined,
            branch: w.branch ?? undefined,
            forkBaseSha: w.fork_base_sha ?? undefined,
          },
        );
        const status = STATUS_OF[outcome];
        if (status) this.deps.publishChange(workerId, status);
      } catch (e) {
        this.deps.log.warn("loop tick failed", { workerId, error: e instanceof Error ? e.message : String(e) });
      } finally {
        this.ticking.delete(workerId);
      }
    })();
  }
}
