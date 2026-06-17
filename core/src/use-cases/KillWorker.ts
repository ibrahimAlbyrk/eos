// KillWorker — escalates SIGTERM→SIGKILL, also force-kills orphan eos-*
// processes whose names match the worker's. After the OS signalling is in
// flight, wipes the worker row + events + pending and publishes
// `worker:removed` so subscribers (SSE) refresh.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { PendingRepo } from "../ports/PendingRepo.ts";
import type { MessageQueueRepo } from "../ports/MessageQueueRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { ProcessSupervisor } from "../ports/ProcessSupervisor.ts";
import type { WorktreeRemovalQueue } from "../ports/WorktreeRemovalQueue.ts";
import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";
import { NotFoundError } from "../errors/index.ts";

export interface KillWorkerDeps {
  workers: WorkerRepo;
  events: EventRepo;
  pending: PendingRepo;
  messageQueue?: MessageQueueRepo;
  bus: EventBus;
  supervisor: ProcessSupervisor;
  log: Logger;
  findOrphanPids(safeName: string): number[];
  // Stop the worker's backend session for an in-process backend (claude-sdk /
  // anthropic-api / …) — it has no supervised PTY child to escalate, so without
  // this its in-process query / agent loop would leak. CLI workers terminate via
  // the supervisor branch; absent in unit tests.
  stopBackendSession?(id: string): void;
  postKillCleanup?(workerId: string): void;
  // Durable worktree-removal intent. Recorded (synchronously, before the row is
  // deleted) so a daemon crash/SIGKILL in the grace window can't strand the
  // tree; a reaper drains it on boot + on an interval. The shared-workspace +
  // git-removal decisions live in the reaper (ReapWorktreeRemovals), not here.
  worktreeRemovals: WorktreeRemovalQueue;
  clock: Clock;
  killGracePeriodMs?: number;
}

export interface KillWorkerResult {
  killed: Array<{ pid: number; via: string }>;
  removed: true;
  wasState: string;
  id: string;
  name: string | null;
}

export function killWorker(deps: KillWorkerDeps, id: string): KillWorkerResult {
  const w = deps.workers.findById(id);
  if (!w) throw new NotFoundError("worker", id);

  // Capture the worktree ref before the row is deleted. A plain-cwd worker has
  // neither worktree_from nor branch → skipped. Each recursive call captures its
  // own child row, so the depth-first recursion cleans the whole subtree.
  const wtRef =
    w.worktree_from && w.branch
      ? { repoRoot: w.worktree_from, worktreeDir: w.worktree_dir ?? null, branch: w.branch }
      : null;

  const killed: Array<{ pid: number; via: string }> = [];

  // Recursively kill children first (depth-first)
  for (const childId of deps.workers.findChildrenIds(id)) {
    try {
      const childResult = killWorker(deps, childId);
      killed.push(...childResult.killed);
    } catch {
      // child may already be gone
    }
  }

  const seen = new Set<number>(killed.map((k) => k.pid));
  const tryKill = (pid: number | null | undefined, via: string): void => {
    if (!pid || pid <= 0 || seen.has(pid)) return;
    deps.supervisor.killPid(pid, "SIGTERM");
    killed.push({ pid, via });
    seen.add(pid);
  };

  if (deps.supervisor.has(id)) {
    deps.supervisor.escalateKill(id);
    // Capture the tracked pid for the kill report; the supervisor already
    // sent SIGTERM and scheduled the SIGKILL escalation.
    if (w.pid != null) {
      killed.push({ pid: w.pid, via: "tracked-child" });
      seen.add(w.pid);
    }
  } else {
    // No supervised PTY child → an in-process backend session (claude-sdk /
    // anthropic-api / …). Stop it through the backend so the in-process query /
    // agent loop actually ends; the pid/pgrep belt below is a no-op for it.
    deps.stopBackendSession?.(id);
  }
  tryKill(w.pid, "stored-pid");

  const safeName = String(w.name || id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const pid of deps.findOrphanPids(safeName)) tryKill(pid, "pgrep");

  const grace = deps.killGracePeriodMs ?? 2000;
  // Best-effort SIGKILL on every pid we touched, after a short grace, in case
  // any one of them ignored SIGTERM. Stays an in-memory timer — moot after a
  // restart anyway (the children died with the daemon).
  setTimeout(() => {
    for (const k of killed) deps.supervisor.killPid(k.pid, "SIGKILL");
  }, grace);

  // Durable worktree teardown: record the intent BEFORE deleting the row, so a
  // crash between the two leaves a queue entry (whose worker row still exists →
  // the reaper's shared check keeps the tree) instead of a silent orphan. The
  // grace defers the reaper until the PTY child's cwd is freed.
  if (wtRef) {
    deps.worktreeRemovals.enqueue({
      id,
      workerId: id,
      repoRoot: wtRef.repoRoot,
      worktreeDir: wtRef.worktreeDir,
      branch: wtRef.branch,
      scheduledAt: deps.clock.now() + grace,
    });
  }

  deps.workers.delete(id);
  deps.events.deleteByWorker(id);
  deps.pending.deleteByWorker(id);
  deps.messageQueue?.deleteByWorker(id);
  deps.postKillCleanup?.(id);
  deps.bus.publish("worker:removed", { workerId: id });

  return { killed, removed: true, wasState: w.state, id, name: w.name ?? null };
}
