import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getSnapshot, subscribe, revalidate, notifyActivity, loadPatch } from "../state/diffStore.js";
import { subscribeGitChange, DIFF_KINDS, GIT_FALLBACK_POLL_MS } from "../state/gitChangeBus.js";
import { workerGitDir } from "../lib/workerGitDir.js";

// Changed-file list + per-file patches for one agent (diffStore cache,
// stale-while-revalidate). Renders the cached snapshot synchronously, then
// revalidates on mount, on a backstop interval, and — the fast path — whenever
// the agent's worktree changes on disk (git:change worktree/index, from any
// source). The dir comes from the live worker row so the call site stays simple.
export function useWorkerChanges(workerId, live) {
  const sub = useCallback((cb) => subscribe(workerId, cb), [workerId]);
  const get = useCallback(() => getSnapshot(workerId), [workerId]);
  const snapshot = useSyncExternalStore(sub, get);

  const gitDir = workerGitDir(live.workers.find((w) => w.id === workerId));

  useEffect(() => {
    revalidate(workerId);
    const t = setInterval(() => revalidate(workerId), GIT_FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, [workerId]);

  useEffect(() => {
    if (!gitDir) return;
    return subscribeGitChange(gitDir, DIFF_KINDS, () => notifyActivity(workerId));
  }, [workerId, gitDir]);

  const refresh = useCallback(() => revalidate(workerId), [workerId]);
  const load = useCallback((file) => loadPatch(workerId, file), [workerId]);

  return { changes: snapshot.changes, patches: snapshot.patches, refresh, loadPatch: load };
}
