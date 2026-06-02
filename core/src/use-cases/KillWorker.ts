// KillWorker — escalates SIGTERM→SIGKILL, also force-kills orphan cm-*
// processes whose names match the worker's. After the OS signalling is in
// flight, wipes the worker row + events + pending and publishes
// `worker:removed` so subscribers (SSE) refresh.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { PendingRepo } from "../ports/PendingRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { ProcessSupervisor } from "../ports/ProcessSupervisor.ts";
import type { Logger } from "../ports/Logger.ts";
import { NotFoundError } from "../errors/index.ts";

export interface KillWorkerDeps {
  workers: WorkerRepo;
  events: EventRepo;
  pending: PendingRepo;
  bus: EventBus;
  supervisor: ProcessSupervisor;
  log: Logger;
  findOrphanPids(safeName: string): number[];
  postKillCleanup?(workerId: string): void;
  // Fire-and-forget worktree+branch removal for an explicitly deleted worker.
  // Invoked after the kill grace (once the PTY child is dead) so it never races
  // the live cwd or the worker's own teardown.
  cleanupWorktree?(ref: { repoRoot: string; worktreeDir: string | null; branch: string }): void;
  killGracePeriodMs?: number;
}

export interface KillWorkerResult {
  killed: Array<{ pid: number; via: string }>;
  removed: true;
  wasState: string;
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
  }
  tryKill(w.pid, "stored-pid");

  const safeName = String(w.name || id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const pid of deps.findOrphanPids(safeName)) tryKill(pid, "pgrep");

  // Best-effort SIGKILL on every pid we touched, after a short grace, in
  // case any one of them ignored SIGTERM. The worktree removal piggybacks on
  // this same grace: by now the PTY child is dead and its cwd is freed, so the
  // force-remove can't race the worker's own teardown or a live working dir.
  setTimeout(() => {
    for (const k of killed) deps.supervisor.killPid(k.pid, "SIGKILL");
    if (wtRef) deps.cleanupWorktree?.(wtRef);
  }, deps.killGracePeriodMs ?? 2000);

  deps.workers.delete(id);
  deps.events.deleteByWorker(id);
  deps.pending.deleteByWorker(id);
  deps.postKillCleanup?.(id);
  deps.bus.publish("worker:removed", { workerId: id });

  return { killed, removed: true, wasState: w.state };
}
