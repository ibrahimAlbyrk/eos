// Project memory routes — list + remove Claude Code's file-based memory for a
// worker's project. Memory is resolved per-worker to its PROJECT (repo) root: a
// worktree worker resolves to its source repo (worktree_from), so all agents in
// a project share the one memory store Claude accumulates there. Removal is
// UI-token gated — an agent holding EOS_DAEMON_URL must not delete the user's
// accumulated memory.

import { realpathSync } from "node:fs";
import { join } from "node:path";

import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import type { WorkerRow } from "../../contracts/src/worker.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import { validate } from "../middleware/validate.ts";
import { MemoryNameSchema } from "../../contracts/src/http.ts";
import { encodeCwd } from "../../core/src/domain/claude-paths.ts";
import { deleteProjectMemory } from "../../core/src/use-cases/DeleteProjectMemory.ts";
import { uiTokenOk } from "./fs-shared.ts";

function memoryDirFor(worker: WorkerRow, claudeHome: string): string | null {
  // Project (repo-root) scope: worktree workers map to their source repo so the
  // panel shows the shared accumulated memory, not the worktree's empty one.
  const base = worker.worktree_from ?? worker.cwd;
  if (!base) return null;
  let real = base;
  // realpath first so the encoded dir matches what Claude itself writes (it
  // canonicalizes symlinks + macOS case before encoding).
  try {
    real = realpathSync(base);
  } catch {}
  return join(claudeHome, "projects", encodeCwd(real), "memory");
}

export function registerMemoryRoutes(r: Router, c: Container): void {
  const resolve = (id: string): { worker: WorkerRow; dir: string } | null => {
    const worker = c.workers.findById(id);
    if (!worker) return null;
    const dir = memoryDirFor(worker, c.claudeHome);
    if (!dir) return null;
    return { worker, dir };
  };

  r.get(/^\/workers\/(?<id>[^/]+)\/memory$/, async ({ params, res }) => {
    const found = resolve(params.id);
    if (!found) {
      writeJson(res, 404, { error: "worker not found or has no project directory" });
      return;
    }
    writeJson(res, 200, { dir: found.dir, entries: await c.projectMemory.list(found.dir) });
  });

  r.del(/^\/workers\/(?<id>[^/]+)\/memory\/(?<name>[^/]+)$/, async ({ params, req, res }) => {
    if (!uiTokenOk(req, c.uiToken)) {
      writeJson(res, 403, { error: "ui token required" });
      return;
    }
    const name = validate(MemoryNameSchema, params.name);
    const found = resolve(params.id);
    if (!found) {
      writeJson(res, 404, { error: "worker not found or has no project directory" });
      return;
    }
    const deleted = await deleteProjectMemory({ store: c.projectMemory }, found.dir, name);
    if (!deleted) {
      writeJson(res, 404, { error: `memory "${name}" not found` });
      return;
    }
    writeJson(res, 200, { ok: true });
  });
}
