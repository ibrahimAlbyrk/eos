import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getSnapshot, subscribe, revalidate } from "../state/gitStatusStore.js";
import { subscribeGitChange, STATUS_KINDS, GIT_FALLBACK_POLL_MS } from "../state/gitChangeBus.js";

const noopSubscribe = () => () => {};
const nullSnapshot = () => null;

// Git status (branch / ahead-behind / stash / conflicts / diff badge) for one
// agent. The cached snapshot renders synchronously (instant on agent switch);
// it revalidates on mount, when this agent's working dir actually changes on
// disk (pushed via git:change — a commit/edit/checkout from ANY source, not just
// this agent's own turns), and on a slow backstop interval. gitDir is the repo
// the chips describe; the dir-keyed git:change subscription is also why a
// sibling sharing this checkout refreshes these chips too.
export function useGitStatus(workerId, { gitDir } = {}) {
  const sub = useCallback(
    (cb) => (workerId ? subscribe(workerId, cb) : noopSubscribe()),
    [workerId],
  );
  const get = useCallback(
    () => (workerId ? getSnapshot(workerId) : null),
    [workerId],
  );
  const status = useSyncExternalStore(sub, get, nullSnapshot);

  useEffect(() => {
    if (!workerId) return;
    revalidate(workerId, gitDir);
    const t = setInterval(() => revalidate(workerId, gitDir), GIT_FALLBACK_POLL_MS);
    return () => clearInterval(t);
  }, [workerId, gitDir]);

  useEffect(() => {
    if (!workerId || !gitDir) return;
    return subscribeGitChange(gitDir, STATUS_KINDS, () => revalidate(workerId, gitDir));
  }, [workerId, gitDir]);

  const refresh = useCallback(() => {
    if (workerId) revalidate(workerId, gitDir);
  }, [workerId, gitDir]);

  return { status, refresh };
}
