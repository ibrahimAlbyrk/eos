import { useCallback, useEffect, useSyncExternalStore } from "react";
import { getSnapshot, subscribe, revalidate } from "../state/gitStatusStore.js";

const REFRESH_MS = 10000;

const noopSubscribe = () => () => {};
const nullSnapshot = () => null;

// Git status for one agent: the cached snapshot renders synchronously (instant
// on agent switch), revalidated on mount, on the agent's own SSE activity
// (debounced per burst), and on a slow interval for out-of-band edits.
export function useGitStatus(workerId, { gitDir, live } = {}) {
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
    const t = setInterval(() => revalidate(workerId, gitDir), REFRESH_MS);
    return () => clearInterval(t);
  }, [workerId, gitDir]);

  useEffect(() => {
    if (!workerId || live?.eventSignal?.workerId !== workerId) return;
    const t = setTimeout(() => revalidate(workerId, gitDir), 600);
    return () => clearTimeout(t);
  }, [live?.eventSignal?.tick, live?.eventSignal?.workerId, workerId, gitDir]);

  const refresh = useCallback(() => {
    if (workerId) revalidate(workerId, gitDir);
  }, [workerId, gitDir]);

  return { status, refresh };
}
