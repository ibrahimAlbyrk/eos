// worker-teardown — the two shared internals of worker removal, extracted
// verbatim from KillWorker so archive/kill/purge compose them instead of
// duplicating either: stopWorkerProcess (OS/backend session termination) and
// cascadeWorkerRemoval (durable worktree intent + row deletes + removal
// publish). No behavior of its own.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { PendingRepo } from "../ports/PendingRepo.ts";
import type { MessageQueueRepo } from "../ports/MessageQueueRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { ProcessSupervisor } from "../ports/ProcessSupervisor.ts";
import type { WorktreeRemovalQueue } from "../ports/WorktreeRemovalQueue.ts";
import type { Clock } from "../ports/Clock.ts";
import type { LoopStateRepo } from "../ports/LoopStateRepo.ts";
import type { WorkerRow } from "../../../contracts/src/worker.ts";

export interface StopWorkerProcessDeps {
  supervisor: ProcessSupervisor;
  findOrphanPids(safeName: string): number[];
  // Stop the worker's backend session for an in-process backend (claude-sdk /
  // anthropic-api / …) — it has no supervised PTY child to escalate, so without
  // this its in-process query / agent loop would leak. CLI workers terminate via
  // the supervisor branch; absent in unit tests.
  stopBackendSession?(id: string): void;
  killGracePeriodMs?: number;
}

// Escalates SIGTERM→SIGKILL on the row's process, also force-killing orphan
// eos-* processes whose names match the worker's. Mutates and returns `killed`
// — callers accumulate a subtree's kills in one array so the grace-SIGKILL
// timer scheduled here sweeps everything pushed so far (recursion included).
export function stopWorkerProcess(
  deps: StopWorkerProcessDeps,
  row: WorkerRow,
  killed: Array<{ pid: number; via: string }> = [],
): Array<{ pid: number; via: string }> {
  const seen = new Set<number>(killed.map((k) => k.pid));
  const tryKill = (pid: number | null | undefined, via: string): void => {
    if (!pid || pid <= 0 || seen.has(pid)) return;
    deps.supervisor.killPid(pid, "SIGTERM");
    killed.push({ pid, via });
    seen.add(pid);
  };

  if (deps.supervisor.has(row.id)) {
    deps.supervisor.escalateKill(row.id);
    // Capture the tracked pid for the kill report; the supervisor already
    // sent SIGTERM and scheduled the SIGKILL escalation.
    if (row.pid != null) {
      killed.push({ pid: row.pid, via: "tracked-child" });
      seen.add(row.pid);
    }
  } else {
    // No supervised PTY child → an in-process backend session (claude-sdk /
    // anthropic-api / …). Stop it through the backend so the in-process query /
    // agent loop actually ends; the pid/pgrep belt below is a no-op for it.
    deps.stopBackendSession?.(row.id);
  }
  tryKill(row.pid, "stored-pid");

  const safeName = String(row.name || row.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const pid of deps.findOrphanPids(safeName)) tryKill(pid, "pgrep");

  const grace = deps.killGracePeriodMs ?? 2000;
  // Best-effort SIGKILL on every pid we touched, after a short grace, in case
  // any one of them ignored SIGTERM. Stays an in-memory timer — moot after a
  // restart anyway (the children died with the daemon).
  setTimeout(() => {
    for (const k of killed) deps.supervisor.killPid(k.pid, "SIGKILL");
  }, grace);

  return killed;
}

export interface CascadeWorkerRemovalDeps {
  workers: Pick<WorkerRepo, "delete">;
  events: Pick<EventRepo, "deleteByWorker">;
  pending: Pick<PendingRepo, "deleteByWorker">;
  messageQueue?: Pick<MessageQueueRepo, "deleteByWorker">;
  // Adopted leak cleanups — optional narrow deps (the stopBackendSession?
  // precedent): worker_loops rows and the ~/.eos conversation transcript were
  // never removed before. Absent in unit tests / pre-wiring callers.
  loops?: Pick<LoopStateRepo, "deleteByWorker">;
  deleteConversation?(sessionId: string): void;
  bus: EventBus;
  postKillCleanup?(workerId: string): void;
  // Durable worktree-removal intent. Recorded (synchronously, before the row is
  // deleted) so a daemon crash/SIGKILL in the grace window can't strand the
  // tree; a reaper drains it on boot + on an interval. The shared-workspace +
  // git-removal decisions live in the reaper (ReapWorktreeRemovals), not here.
  worktreeRemovals: WorktreeRemovalQueue;
  clock: Clock;
  killGracePeriodMs?: number;
}

// Removes one worker row and everything hanging off it: durable worktree
// removal intent, the four row deletes, per-worker cleanup hook, and the
// `worker:removed` publish. Recursion over a subtree is the caller's job.
export function cascadeWorkerRemoval(deps: CascadeWorkerRemovalDeps, row: WorkerRow): void {
  // A plain-cwd worker has neither worktree_from nor branch → skipped. The row
  // object is a pre-delete snapshot, so reading the ref here is safe.
  const wtRef =
    row.worktree_from && row.branch
      ? { repoRoot: row.worktree_from, worktreeDir: row.worktree_dir ?? null, branch: row.branch }
      : null;

  const grace = deps.killGracePeriodMs ?? 2000;
  // Record the intent BEFORE deleting the row, so a crash between the two
  // leaves a queue entry (whose worker row still exists → the reaper's shared
  // check keeps the tree) instead of a silent orphan. The grace defers the
  // reaper until the PTY child's cwd is freed.
  if (wtRef) {
    deps.worktreeRemovals.enqueue({
      id: row.id,
      workerId: row.id,
      repoRoot: wtRef.repoRoot,
      worktreeDir: wtRef.worktreeDir,
      branch: wtRef.branch,
      scheduledAt: deps.clock.now() + grace,
    });
  }

  deps.workers.delete(row.id);
  deps.events.deleteByWorker(row.id);
  deps.pending.deleteByWorker(row.id);
  deps.messageQueue?.deleteByWorker(row.id);
  deps.loops?.deleteByWorker(row.id);
  if (row.session_id != null) deps.deleteConversation?.(row.session_id);
  deps.postKillCleanup?.(row.id);
  deps.bus.publish("worker:removed", { workerId: row.id });
}
