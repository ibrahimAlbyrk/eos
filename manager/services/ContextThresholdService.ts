// ContextThresholdService — the context-budget watcher. Structural twin of
// ReportGapService: it rides the same per-worker IDLE edge (daemon queue-drain
// "empty" branch) and, when a worker's context-window occupancy crosses a
// threshold, notifies the worker's DIRECT parent with a one-time system_message.
//
//   * warn90 (≈90% full): a heads-up. The worker keeps running; the parent should
//     start planning a handoff.
//   * full (≈95% full): the worker is auto-suspended (worktree preserved) and the
//     parent told it was stopped.
//
// Exactly-once is a persistent latch (ContextMarkRepo), not an in-memory Set:
// mark() returns true only on the first crossing per (worker, stage), so a repeat
// IDLE at the same occupancy is a no-op, and the two stages latch independently.
// A context epoch reset (used === 0 after a /clear or a fresh session) clears the
// latch so the next fill can warn/suspend again.
//
// House rule: it never looks at backend_kind. It branches only on row/limit data
// and the parent link; suspend + dispatch are both lane-agnostic below this point.

import type { WorkerRepo } from "../../core/src/ports/WorkerRepo.ts";
import type { ContextMarkRepo } from "../../core/src/ports/ContextMarkRepo.ts";
import type { Logger } from "../../core/src/ports/Logger.ts";
import { computeContextPct } from "../../core/src/domain/context-usage.ts";

// Operator-specified bodies (Turkish, per §4). The structured data (stage, pct,
// worker id/name) rides the sender-tag attributes; the body stays plain prose.
const WARN_BODY = (name: string): string => `${name} worker'ının context'i dolmak üzere, %90'a ulaştı`;
const FULL_BODY = "agent'ın context'i doldu ve durduruldu";

export interface ContextThresholdDeps {
  workers: Pick<WorkerRepo, "findById">;
  marks: ContextMarkRepo;
  contextWindowFor(model: string | null | undefined): number | null;
  // Rides the same dispatch chokepoint as every other injection — the sender tag
  // wraps the body once as <system_message kind="context_threshold" …>; queued
  // behind a busy parent, it lands on the parent's next IDLE (fan-in serialized).
  dispatch(input: {
    workerId: string;
    text: string;
    displayText: string;
    envelope: { kind: "context_threshold"; stage: "warn90" | "full"; fromWorker: string; workerName?: string; pct?: number };
    queueWhenBusy: boolean;
    origin: string;
  }): Promise<unknown>;
  // Auto-suspend the worker (stop session, SUSPENDED, clear runtime) — worktree
  // preserved. Synchronous; the session stop's process exit settles async.
  suspend(workerId: string, reason: string): void;
  warnRatio: number;
  fullRatio: number;
  log: Logger;
}

export class ContextThresholdService {
  private readonly deps: ContextThresholdDeps;

  constructor(deps: ContextThresholdDeps) {
    this.deps = deps;
  }

  checkOnIdle(workerId: string): void {
    const w = this.deps.workers.findById(workerId);
    if (!w) return;
    // No parent to notify → skip entirely (the root orchestrator is never
    // auto-suspended or warned; spawned workers always have a parent).
    if (w.parent_id == null) return;

    const used = w.last_context_tokens ?? 0;
    const limit = this.deps.contextWindowFor(w.model);
    const pct = computeContextPct(used, limit);
    if (pct == null) return; // unknown limit → silent (fail-open, never a false threshold)

    // Context epoch reset (/clear or a fresh session drops occupancy to 0) — re-arm
    // every stage so a subsequent fill can warn/suspend again.
    if (used === 0) { this.deps.marks.clear(workerId); return; }

    const parentId = w.parent_id;
    const workerName = w.name ?? workerId;

    // mark() BEFORE fire (the SQLite latch is the exactly-once guarantee): a repeat
    // IDLE at the same occupancy never double-fires. Full latches independently of
    // warn, so a worker that crossed 90 earlier still suspends at 95.
    if (pct >= this.deps.fullRatio * 100) {
      if (this.deps.marks.mark(workerId, "full")) {
        this.deps.suspend(workerId, "context_full");
        void this.fire(parentId, { kind: "context_threshold", stage: "full", fromWorker: workerId, workerName }, FULL_BODY);
      }
    } else if (pct >= this.deps.warnRatio * 100) {
      if (this.deps.marks.mark(workerId, "warn90")) {
        void this.fire(parentId, { kind: "context_threshold", stage: "warn90", fromWorker: workerId, workerName, pct }, WARN_BODY(workerName));
      }
    }
  }

  private async fire(
    parentId: string,
    envelope: { kind: "context_threshold"; stage: "warn90" | "full"; fromWorker: string; workerName?: string; pct?: number },
    text: string,
  ): Promise<void> {
    try {
      await this.deps.dispatch({
        workerId: parentId,
        text,
        // The chat renders the bare body; the <system_message> wrapper never
        // reaches the UI.
        displayText: text,
        envelope,
        queueWhenBusy: true,
        origin: "context-threshold",
      });
    } catch (e) {
      this.deps.log.warn("context threshold dispatch failed", { parentId, stage: envelope.stage, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
