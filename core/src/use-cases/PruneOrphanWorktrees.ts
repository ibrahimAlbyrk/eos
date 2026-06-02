// PruneOrphanWorktrees — daemon-startup reconciliation. Removes git worktrees
// that belonged to deleted workers (row gone) but were left on disk because the
// old delete path never cleaned them up (and any worktree stranded by a kill
// whose deferred cleanup didn't run before the daemon died).
//
// Safety is keyed on BRANCH MEMBERSHIP in live rows, never on a persisted dir:
// a live worker's branch is non-null (generated daemon-side at insert), so it is
// always in liveBranches and never pruned. Conjunctive guards: only a worktree
// whose branch is cm-*, is not owned by any live row, sits under the managed
// .claude-mgr/worktrees/ tree, and is neither the main nor a locked worktree.
//
// Transition guard: a pre-fix row may have a worktree (worktree_from set) but a
// NULL branch — we can't know which on-disk worktree is its preserved copy, so
// we refuse to prune ANY worktree in that repo. This self-deactivates once all
// rows carry branches.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { WorktreeManager } from "../ports/WorktreeManager.ts";
import type { Logger } from "../ports/Logger.ts";

export interface PruneOrphanWorktreesDeps {
  workers: WorkerRepo;
  worktrees: WorktreeManager;
  log: Logger;
}

const MANAGED_SEGMENT = "/.claude-mgr/worktrees/";

export async function pruneOrphanWorktrees(deps: PruneOrphanWorktreesDeps): Promise<void> {
  const rows = deps.workers.listAll();
  const repoRoots = new Set<string>();
  const liveBranches = new Set<string>();
  const ambiguousRepos = new Set<string>();
  for (const r of rows) {
    if (!r.worktree_from) continue;
    repoRoots.add(r.worktree_from);
    if (r.branch) liveBranches.add(r.branch);
    else ambiguousRepos.add(r.worktree_from);
  }

  for (const repoRoot of repoRoots) {
    if (ambiguousRepos.has(repoRoot)) {
      deps.log.warn("worktree prune skipped: repo has a worktree worker with no recorded branch", { repoRoot });
      continue;
    }
    let entries;
    try {
      entries = await deps.worktrees.listWorktrees(repoRoot);
    } catch (e) {
      deps.log.warn("worktree list failed", { repoRoot, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    for (const e of entries) {
      if (e.isMain || e.locked) continue;
      if (!e.branch || !e.branch.startsWith("cm-")) continue;
      if (liveBranches.has(e.branch)) continue;
      if (!e.path.includes(MANAGED_SEGMENT)) continue;
      const res = await deps.worktrees.remove({ repoRoot, worktreeDir: e.path, branch: e.branch });
      deps.log.info("pruned orphan worktree", {
        repoRoot, path: e.path, branch: e.branch, removed: res.removed, reason: res.reason,
      });
    }
  }
}
