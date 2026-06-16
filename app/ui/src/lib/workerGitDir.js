// The working dir a worker's git state lives in: the isolated worktree if it has
// one, else its checkout cwd, else the source repo it forked from. This is the
// key the daemon's GitWatcher tags git:change events with (gitWorkingDirOf in
// container.ts) — keep the two in lockstep so pushed events line up with the
// store entries/subscriptions that revalidate on them.
export function workerGitDir(worker) {
  if (!worker) return null;
  return worker.worktree_dir ?? worker.cwd ?? worker.worktree_from ?? null;
}
