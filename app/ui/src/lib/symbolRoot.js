// Resolve the symbol-index root for the Code view's File panel. That panel opens
// absolute paths with no explicit root, but the worker that owns the file has a
// worktree/cwd that IS the repo root the index should scope to. Longest-prefix
// match picks the most specific containing dir (an isolated worktree over the
// shared checkout). Returns null when no worker contains the path — the caller
// then renders no CodeLens, a quiet no-op.
export function repoRootForPath(path, workers) {
  if (!path || !Array.isArray(workers)) return null;
  let best = null;
  for (const w of workers) {
    const root = w?.worktree_dir || w?.cwd;
    if (!root) continue;
    const prefix = root.endsWith("/") ? root : root + "/";
    if (path === root || path.startsWith(prefix)) {
      if (!best || root.length > best.length) best = root;
    }
  }
  return best;
}
