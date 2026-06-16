// Single source of truth for "does this agent have unintegrated work?" —
// the predicate drove visibility in four places with hand-copied variants,
// which is how the hub strip ended up active for clean worktrees.

export function hasUnintegratedWork(diff) {
  return Boolean(diff && (diff.insertions > 0 || diff.deletions > 0 || diff.files > 0));
}

// Does the git row have anything worth showing? Changes, unsynced commits,
// conflicts, stashes, or a real verdict — a bare "this is a git repo" is not
// a reason to occupy composer space on the orchestrator.
export function isRowRelevant({ diff = null, ahead = 0, behind = 0, stash = 0, conflicts = 0, verdict = null } = {}) {
  return (
    hasUnintegratedWork(diff) ||
    ahead > 0 ||
    behind > 0 ||
    stash > 0 ||
    conflicts > 0 ||
    Boolean(verdict)
  );
}
