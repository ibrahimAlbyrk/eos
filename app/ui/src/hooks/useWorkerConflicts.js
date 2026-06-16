import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getSnapshot, subscribe, revalidate, notifyActivity, loadDoc } from "../state/conflictStore.js";
import { subscribeGitChange, CONFLICT_KINDS, GIT_FALLBACK_POLL_MS } from "../state/gitChangeBus.js";
import { workerGitDir } from "../lib/workerGitDir.js";

// Conflicted-file list + per-file parsed documents for one agent (conflictStore
// cache). Mirrors useWorkerChanges: synchronous cached render, revalidate on
// mount + backstop interval + git:change (conflict/index — a merge starts/ends
// or a file is staged-resolved) for the worktree, from any source.
export function useWorkerConflicts(workerId, live) {
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
    return subscribeGitChange(gitDir, CONFLICT_KINDS, () => notifyActivity(workerId));
  }, [workerId, gitDir]);

  const refresh = useCallback(() => revalidate(workerId), [workerId]);
  const load = useCallback((path) => loadDoc(workerId, path), [workerId]);

  return { list: snapshot.list, docs: snapshot.docs, refresh, loadDoc: load };
}
