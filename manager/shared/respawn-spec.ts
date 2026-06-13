// Rebuilds a SpawnWorkerSpec for resuming a dead worker from its persisted
// row. Mirrors the spawn routes' derivation (routes/workers.ts POST /workers,
// routes/orchestrators.ts POST /orchestrators): role/permission mode are
// re-derived the same way; the system prompt is assembled daemon-side by the
// claude-cli backend (DPI) from role + worktree facts, so no prompt file is set
// here; mcp config + gateway wiring are re-synthesized by buildArgs on launch.
// cwd reattaches to the existing worktree dir (no worktreeFrom — the worktree
// must NOT be recreated); the row keeps its worktree_from/branch columns for
// delete-time cleanup.

import type { WorkerRow } from "../../contracts/src/worker.ts";
import type { SpawnWorkerSpec } from "../../core/src/use-cases/SpawnWorker.ts";

export interface RespawnSpecDeps {
  modeResolver: { resolveFor(id: string): string };
}

export function buildRespawnSpec(row: WorkerRow, deps: RespawnSpecDeps): SpawnWorkerSpec {
  const isGitAgent = row.agent_role === "git";
  const isOrchestrator = !!row.is_orchestrator;
  const parentId = row.parent_id ?? undefined;

  return {
    prompt: "",
    cwd: row.worktree_dir ?? row.cwd ?? undefined,
    name: row.name ?? undefined,
    parentId,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    isOrchestrator,
    role: row.agent_role ?? undefined,
    persistent: isOrchestrator || isGitAgent || !!parentId,
    // with_gateway predates migration 026 on old rows — fall back to the
    // orchestrator-dispatched heuristic (spawn_worker defaults gateway on).
    withGateway: row.with_gateway != null ? !!row.with_gateway : !!parentId,
    claudePermissionMode:
      row.permission_mode ?? (parentId ? deps.modeResolver.resolveFor(parentId) : undefined),
  };
}
