import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { gitDiffKey, getSnapshot, subscribe, revalidate, notifyActivity, loadPatch } from "../state/gitDiffStore.js";
import { subscribeGitChange, GITDIFF_KINDS, GIT_FALLBACK_POLL_MS } from "../state/gitChangeBus.js";
import { startPolling } from "../lib/pollInterval.js";

// Changed-file list + per-file patches for one repo dir at one scope
// (gitDiffStore cache, stale-while-revalidate). The working-tree and branch
// scopes mirror useWorkerChanges: revalidate on mount, on a backstop interval,
// and — the fast path — whenever the dir's git state changes (git:change, any
// source). A commit scope is immutable history: fetched once, no bus, no
// interval.
export function useGitScopeChanges(cwd, scope) {
  const kind = scope.kind;
  const sha = kind === "commit" ? scope.sha : null;
  const base = kind === "branch" ? scope.base ?? null : null;
  // Rebuilt from primitives so a caller passing a fresh scope object per
  // render never churns the effects below.
  const stableScope = useMemo(() => {
    if (kind === "commit") return { kind, sha };
    if (kind === "branch") return { kind, base };
    return { kind: "all" };
  }, [kind, sha, base]);
  const key = gitDiffKey(cwd, stableScope);

  const sub = useCallback((cb) => subscribe(key, cb), [key]);
  const get = useCallback(() => getSnapshot(key), [key]);
  const snapshot = useSyncExternalStore(sub, get);

  useEffect(() => {
    revalidate(cwd, stableScope);
    if (stableScope.kind === "commit") return;
    return startPolling(() => revalidate(cwd, stableScope), GIT_FALLBACK_POLL_MS);
  }, [cwd, stableScope]);

  useEffect(() => {
    if (stableScope.kind === "commit") return;
    return subscribeGitChange(cwd, GITDIFF_KINDS, () => notifyActivity(cwd, stableScope));
  }, [cwd, stableScope]);

  const refresh = useCallback(() => revalidate(cwd, stableScope), [cwd, stableScope]);
  const load = useCallback((file) => loadPatch(cwd, stableScope, file), [cwd, stableScope]);

  return { changes: snapshot.changes, patches: snapshot.patches, refresh, loadPatch: load };
}
