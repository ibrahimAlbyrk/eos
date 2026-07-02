// KillWorker — depth-first subtree kill: stops each worker's process
// (SIGTERM→SIGKILL escalation) and cascades the row removal + `worker:removed`
// publish. The two mechanics live in worker-teardown.ts, shared with
// archive/purge; this use-case owns only the recursion and its result shape.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { PendingRepo } from "../ports/PendingRepo.ts";
import type { MessageQueueRepo } from "../ports/MessageQueueRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { ProcessSupervisor } from "../ports/ProcessSupervisor.ts";
import type { WorktreeRemovalQueue } from "../ports/WorktreeRemovalQueue.ts";
import type { Clock } from "../ports/Clock.ts";
import type { LoopStateRepo } from "../ports/LoopStateRepo.ts";
import type { Logger } from "../ports/Logger.ts";
import { NotFoundError } from "../errors/index.ts";
import { stopWorkerProcess, cascadeWorkerRemoval } from "./worker-teardown.ts";

export interface KillWorkerDeps {
  workers: WorkerRepo;
  events: EventRepo;
  pending: PendingRepo;
  messageQueue?: MessageQueueRepo;
  // Adopted leak cleanups, executed by the shared cascade when wired: loop rows
  // + the conversation transcript (keyed by the row's session_id).
  loops?: Pick<LoopStateRepo, "deleteByWorker">;
  deleteConversation?(sessionId: string): void;
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

  stopWorkerProcess(deps, w, killed);
  cascadeWorkerRemoval(deps, w);

  return { killed, removed: true, wasState: w.state, id, name: w.name ?? null };
}
