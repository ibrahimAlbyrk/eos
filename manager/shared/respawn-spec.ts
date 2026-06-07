// Rebuilds a SpawnWorkerSpec for resuming a dead worker from its persisted
// row. Mirrors the spawn routes' derivation (routes/workers.ts POST /workers,
// routes/orchestrators.ts POST /orchestrators): prompt files and permission
// mode are re-derived the same way; mcp config + gateway wiring are
// re-synthesized by the container's buildArgs on launch. cwd reattaches to the
// existing worktree dir (no worktreeFrom — the worktree must NOT be recreated);
// the row keeps its worktree_from/branch columns for delete-time cleanup.

import type { WorkerRow } from "../../contracts/src/worker.ts";
import type { SpawnWorkerSpec } from "../../core/src/use-cases/SpawnWorker.ts";

export interface RespawnSpecDeps {
  config: {
    paths: {
      orchestratorPromptFile: string;
      workerPromptFile: string;
      gitAgentPromptFile: string;
    };
  };
  modeResolver: { resolveFor(id: string): string };
}

export function buildRespawnSpec(row: WorkerRow, deps: RespawnSpecDeps): SpawnWorkerSpec {
  const isGitAgent = row.agent_role === "git";
  const isOrchestrator = !!row.is_orchestrator;
  const parentId = row.parent_id ?? undefined;

  const systemPromptFile = isOrchestrator
    ? deps.config.paths.orchestratorPromptFile
    : isGitAgent
      ? deps.config.paths.gitAgentPromptFile
      : parentId
        ? deps.config.paths.workerPromptFile
        : undefined;

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
    systemPromptFile,
    // with_gateway predates migration 026 on old rows — fall back to the
    // orchestrator-dispatched heuristic (spawn_worker defaults gateway on).
    withGateway: row.with_gateway != null ? !!row.with_gateway : !!parentId,
    claudePermissionMode:
      row.permission_mode ?? (parentId ? deps.modeResolver.resolveFor(parentId) : undefined),
  };
}
