// sessionRootOf — resolve an agent's sessionKey: the id of its parent-chain
// ROOT worker row (a dashboard "session" is a root row plus its descendants).
// Same cycle-guarded O(depth) walk as SqlBackedModeResolver. An unknown id
// returns itself (the caller decides whether that is acceptable — the browser
// routes validate the id against the repo before trusting the result).

import type { WorkerRepo } from "../ports/WorkerRepo.ts";

export function sessionRootOf(workers: Pick<WorkerRepo, "findById">, id: string): string {
  let cursor: string | null = id;
  let last = id;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const w = workers.findById(cursor);
    if (!w) break;
    last = cursor;
    cursor = w.parent_id ?? null;
  }
  return last;
}

// The folder a session works on: its root row's checkout, else the repo a
// worktree root forked from; null for an unknown id. Mirrors the web's
// projectPathFor, so what an agent files under a project is what the user sees.
export function sessionProjectOf(workers: Pick<WorkerRepo, "findById">, id: string): string | null {
  const root = workers.findById(sessionRootOf(workers, id));
  return root?.cwd ?? root?.worktree_from ?? null;
}
