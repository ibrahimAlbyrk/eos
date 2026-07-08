import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { gitDiffKey, getSnapshot, subscribe, revalidate, notifyActivity, loadPatch } from "../state/gitDiffStore.js";
import { subscribeGitChange, GITDIFF_KINDS, GIT_FALLBACK_POLL_MS } from "../state/gitChangeBus.js";

// Changed-file list + per-file patches for one repo dir at one scope
// (gitDiffStore cache, stale-while-revalidate). The working-tree scope
// mirrors useWorkerChanges: revalidate on mount, on a backstop interval, and —
// the fast path — whenever the dir's git state changes (git:change, any
// source). A commit scope is immutable history: fetched once, no bus, no
// interval.
export function useGitScopeChanges(cwd, scope) {
  const isAll = scope.kind !== "commit";
  const sha = isAll ? null : scope.sha;
  // Rebuilt from primitives so a caller passing a fresh scope object per
  // render never churns the effects below.
  const stableScope = useMemo(() => (isAll ? { kind: "all" } : { kind: "commit", sha }), [isAll, sha]);
  const key = gitDiffKey(cwd, stableScope);

  const sub = useCallback((cb) => subscribe(key, cb), [key]);
  const get = useCallback(() => getSnapshot(key), [key]);
  const snapshot = useSyncExternalStore(sub, get);

  useEffect(() => {
    revalidate(cwd, stableScope);
    if (stableScope.kind === "commit") return;
    const t = setInterval(() => revalidate(cwd, stableScope), GIT_FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, [cwd, stableScope]);

  useEffect(() => {
    if (stableScope.kind === "commit") return;
    return subscribeGitChange(cwd, GITDIFF_KINDS, () => notifyActivity(cwd, stableScope));
  }, [cwd, stableScope]);

  const refresh = useCallback(() => revalidate(cwd, stableScope), [cwd, stableScope]);
  const load = useCallback((file) => loadPatch(cwd, stableScope, file), [cwd, stableScope]);

  return { changes: snapshot.changes, patches: snapshot.patches, refresh, loadPatch: load };
}
