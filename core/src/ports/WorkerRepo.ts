// WorkerRepo — persistence port for worker rows. Adapter is SqliteWorkerRepo
// in infra/persistence/.

import type { WorkerRow } from "../../../contracts/src/worker.ts";
import type { WorkerState } from "../../../contracts/src/events.ts";

export interface InsertWorkerInput {
  id: string;
  prompt: string;
  cwd: string | null;
  worktreeFrom: string | null;
  branch: string | null;
  name: string | null;
  pid: number | null;
  port: number;
  startedAt: number;
  parentId: string | null;
  model: string;
  effort: string | null;
  isOrchestrator: boolean;
}

export interface UsageDelta {
  in: number;
  out: number;
  cacheRead: number;
  cacheCreate: number;
  cacheCreate1h: number;
  costUsd: number;
}

export interface WorkerRepo {
  insert(input: InsertWorkerInput): void;
  findById(id: string): WorkerRow | null;
  listAll(): WorkerRow[];
  listOrchestrators(): WorkerRow[];
  updateState(id: string, state: WorkerState): void;
  markDone(id: string, endedAt: number, exitCode: number | null): void;
  addUsage(id: string, delta: UsageDelta): void;
  incrementToolCalls(id: string): void;
  updateName(id: string, name: string | null): void;
  updatePermissionMode(id: string, mode: string): void;
  updateModel(id: string, model: string, effort: string | null): void;
  // Persist the resolved (realpath'd) worktree directory once the worker
  // reports it — enrichment only; branch is written at insert.
  setWorktreeDir(id: string, worktreeDir: string): void;
  delete(id: string): void;
  findChildrenIds(parentId: string): string[];
  // Aggregate helpers consumed by /session and /metrics — keep here so the
  // route layer doesn't compose SQL.
  totalCost(): number;
  countByState(): Array<{ state: string; n: number }>;
  countActive(): { active: number; total: number };
  earliestOrchestratorStart(): number | null;
}
