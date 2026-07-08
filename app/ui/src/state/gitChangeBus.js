// Path-keyed git-change fan-out — the single channel for "this repo dir's git
// state changed." useLive translates each SSE git:change into emitGitChange(dir,
// kinds); the git views (chips, diff, conflicts, commits, branch) subscribe by
// the working dir they display. A commit/edit/checkout from ANY source — the
// agent's PTY, the composer "!" terminal, an external shell, or a sibling worker
// sharing the same checkout — revalidates exactly the views for that dir, with
// no dependence on which worker's event happened to fire (the old eventSignal
// gate's blind spot). Keying by dir (not workerId) is also why siblings sharing
// a checkout both refresh.

const subs = new Map(); // dir -> Set<handler(kinds)>

// Backstop poll: push covers the real-time path, so this only catches a missed
// event / a dir the watcher hadn't attached yet. One uniform cadence across all
// git views (was 10s here, none there).
export const GIT_FALLBACK_POLL_MS = 30000;

// Which GitChangeKinds each view cares about — revalidate only when one is
// present, so a working-tree edit doesn't refetch the branch list, etc.
export const STATUS_KINDS = ["head", "refs", "stash", "conflict"]; // branch/ahead-behind/stash/conflict chips
export const DIFF_KINDS = ["worktree", "index"];                   // changed-file list + badge
export const CONFLICT_KINDS = ["conflict", "index"];               // merge-conflict resolver
export const COMMITS_KINDS = ["head", "refs"];                     // unpushed commits panel
export const TRY_KINDS = ["worktree", "index"];                    // try syncable delta
export const BRANCH_KINDS = ["head", "refs"];                      // config-row branch chip
// Git Diff panel working-tree scope: diffs against the merge-base with the
// default branch, so commits/checkouts (head/refs) move it too.
export const GITDIFF_KINDS = ["worktree", "index", "head", "refs"];
export const STASH_KINDS = ["stash"];                              // gitdiff stashes section

// Subscribe to a dir's git changes, filtered to `wantedKinds`. `cb` is called
// (no args) whenever a matching change arrives. An event with no kinds is
// treated as "refetch" (fail-safe). Returns an unsubscribe; a null dir is a noop.
export function subscribeGitChange(dir, wantedKinds, cb) {
  if (!dir) return () => {};
  const handler = (kinds) => {
    if (!kinds || kinds.length === 0 || kinds.some((k) => wantedKinds.includes(k))) cb();
  };
  let set = subs.get(dir);
  if (!set) {
    set = new Set();
    subs.set(dir, set);
  }
  set.add(handler);
  return () => {
    const s = subs.get(dir);
    if (!s) return;
    s.delete(handler);
    if (s.size === 0) subs.delete(dir);
  };
}

export function emitGitChange(dir, kinds) {
  const set = dir ? subs.get(dir) : null;
  if (!set) return;
  for (const handler of [...set]) handler(kinds ?? []);
}
