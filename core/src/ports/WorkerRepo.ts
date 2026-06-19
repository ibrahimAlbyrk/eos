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
  backendKind: string;
  backendProfile: string | null;
  agentRole: string | null;
  // Resolved worker-type name (built-in / file / runtime), or null for untyped.
  workerType: string | null;
  withGateway: boolean;
  collaborate: boolean;
  // Known at insert for worktree spawns: precomputed for a fresh worktree
  // (daemon derives the dir before the worker creates it) or copied from the
  // workspaceOf target when attaching. Lifecycle enrichment stays as self-heal.
  worktreeDir: string | null;
  workspaceOwnerId: string | null;
  // False only for fresh-worktree spawns: the precomputed worktree_dir does
  // not exist on disk yet. Flipped by setWorkspaceReady when the worker's
  // claude_spawning event confirms creation. Plain-cwd and attach spawns are
  // born ready (their tree already exists).
  workspaceReady: boolean;
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
  listByParent(parentId: string): WorkerRow[];
  listOrchestrators(): WorkerRow[];
  updateState(id: string, state: WorkerState): void;
  // Turn clock — stamped on every entry into the busy set (see TransitionState).
  setTurnStartedAt(id: string, ts: number): void;
  markDone(id: string, endedAt: number, exitCode: number | null): void;
  // Accumulate the cumulative billing ledger (tokens_*/cost_usd). Does NOT touch
  // context-window occupancy — that is a separate snapshot (setContextTokens),
  // because a turn-aggregate usage delta is the right input for cost but wrong
  // for the live context footprint.
  addUsage(id: string, delta: UsageDelta): void;
  // Overwrite the context-window occupancy snapshot (last_context_tokens) the UI
  // ring reads. SET, never summed: the latest per-request prompt footprint wins.
  setContextTokens(id: string, tokens: number): void;
  incrementToolCalls(id: string): void;
  updateName(id: string, name: string | null): void;
  updatePermissionMode(id: string, mode: string): void;
  updateModel(id: string, model: string, effort: string | null): void;
  // Persist the resolved (realpath'd) worktree directory once the worker
  // reports it — enrichment only; branch is written at insert.
  setWorktreeDir(id: string, worktreeDir: string): void;
  // Persist the fork commit captured at worktree creation — the stable diff
  // base (never re-derived from the source checkout's moving HEAD).
  setForkBaseSha(id: string, sha: string): void;
  // Mark the workspace materialized on disk — gates agent-scoped git reads.
  setWorkspaceReady(id: string): void;
  // Persist the claude session id the worker reports on capture/swap — the
  // key for resuming the conversation after the process dies.
  setSessionId(id: string, sessionId: string): void;
  // Persist the agent's task-list snapshot (Claude's TodoWrite) as a JSON
  // string, or null to clear it (/clear). Stamped from the canonical tool_call
  // reducer; the web TaskTray reads workers.tasks straight off the row.
  setTasks(id: string, tasksJson: string | null): void;
  // Null out pid/port when the process is known dead (suspend) — a stale pid
  // could be reused by an unrelated process and get signalled on delete.
  clearRuntime(id: string): void;
  // Resume: re-bind a revived row to its new process. State moves separately
  // (TransitionState); started_at and cost counters carry on.
  reactivate(id: string, runtime: { pid: number | null; port: number }): void;
  delete(id: string): void;
  findChildrenIds(parentId: string): string[];
  // Aggregate helper consumed by /metrics — keep here so the route layer
  // doesn't compose SQL.
  countByState(): Array<{ state: string; n: number }>;
}
