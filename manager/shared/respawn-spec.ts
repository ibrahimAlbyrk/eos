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
  // Re-resolves a persisted worker_definition from disk so a resumed worker re-gets
  // its DPI body + persistence default. model/effort/permission are read from
  // the row (they may have changed at runtime) — only the body + persistence
  // come from the definition. Runtime-created definitions are gone after a daemon restart
  // (the O1 documented limitation); the baked row values still apply. Absent
  // (or no match) ⇒ no definition body, behavior preserved.
  resolveWorkerDefinition?: (name: string) => { body: string; persistent?: boolean } | null;
}

export function buildRespawnSpec(row: WorkerRow, deps: RespawnSpecDeps): SpawnWorkerSpec {
  const isGitAgent = row.agent_role === "git";
  const isOrchestrator = !!row.is_orchestrator;
  const parentId = row.parent_id ?? undefined;
  const workerDefinition = row.worker_definition ?? undefined;
  const def = workerDefinition && deps.resolveWorkerDefinition ? deps.resolveWorkerDefinition(workerDefinition) : null;

  return {
    prompt: "",
    cwd: row.worktree_dir ?? row.cwd ?? undefined,
    name: row.name ?? undefined,
    parentId,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    isOrchestrator,
    role: row.agent_role ?? undefined,
    // Peer-mesh opt-in is a spawn fact both lanes read from spec.collaborate;
    // dropping it on resume silently strips a collaborate worker's peer tools.
    collaborate: !!row.collaborate,
    persistent: isOrchestrator || isGitAgent || !!parentId || !!def?.persistent,
    // with_gateway predates migration 026 on old rows — fall back to the
    // orchestrator-dispatched heuristic (spawn_worker defaults gateway on).
    withGateway: row.with_gateway != null ? !!row.with_gateway : !!parentId,
    claudePermissionMode:
      row.permission_mode ?? (parentId ? deps.modeResolver.resolveFor(parentId) : undefined),
    workerDefinition,
    workerDefinitionBody: def?.body ?? undefined,
  };
}
