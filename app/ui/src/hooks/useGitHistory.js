import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { subscribeGitChange, COMMITS_KINDS, STASH_KINDS, GIT_FALLBACK_POLL_MS } from "../state/gitChangeBus.js";
import { startPolling } from "../lib/pollInterval.js";

// /fs/log caps limit at 100 — refreshes clamp their window to it.
const PAGE = 30;
const LOG_LIMIT_MAX = 100;

// Paged HEAD history for the Changes panel's scope menu. Only fetches while
// `enabled` (the menu is open). New commits land via the git-change bus
// (head/refs) with the poll as backstop; a refresh re-reads the window already
// loaded so "show more" pages survive it.
export function useGitLog(cwd, enabled) {
  const [commits, setCommits] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [paging, setPaging] = useState(false);
  const countRef = useRef(0);

  useEffect(() => {
    if (!enabled || !cwd) return;
    let cancelled = false;
    const refetch = async () => {
      const limit = Math.min(Math.max(PAGE, countRef.current), LOG_LIMIT_MAX);
      const r = await api.getGitLog(cwd, { limit });
      if (cancelled) return;
      setCommits(r.commits ?? []);
      setHasMore(Boolean(r.hasMore));
      countRef.current = (r.commits ?? []).length;
    };
    refetch();
    const stop = startPolling(refetch, GIT_FALLBACK_POLL_MS);
    const unsub = subscribeGitChange(cwd, COMMITS_KINDS, refetch);
    return () => { cancelled = true; stop(); unsub(); };
  }, [cwd, enabled]);

  const showMore = useCallback(async () => {
    setPaging(true);
    try {
      const r = await api.getGitLog(cwd, { limit: PAGE, skip: countRef.current });
      setCommits((prev) => {
        const seen = new Set((prev ?? []).map((c) => c.sha));
        const merged = [...(prev ?? []), ...(r.commits ?? []).filter((c) => !seen.has(c.sha))];
        countRef.current = merged.length;
        return merged;
      });
      setHasMore(Boolean(r.hasMore));
    } finally {
      setPaging(false);
    }
  }, [cwd]);

  return { commits, hasMore, paging, showMore };
}

// The repo's stashes, kept fresh by the git-change bus "stash" kind with the
// shared poll backstop. `refetch` re-reads at once after an apply/drop.
export function useGitStashes(cwd, enabled) {
  const [stashes, setStashes] = useState(null);

  const refetch = useCallback(async () => {
    const r = await api.getGitStashes(cwd);
    setStashes(r.stashes ?? []);
  }, [cwd]);

  useEffect(() => {
    if (!enabled || !cwd) return;
    let cancelled = false;
    const run = async () => {
      const r = await api.getGitStashes(cwd);
      if (!cancelled) setStashes(r.stashes ?? []);
    };
    run();
    const stop = startPolling(run, GIT_FALLBACK_POLL_MS);
    const unsub = subscribeGitChange(cwd, STASH_KINDS, run);
    return () => { cancelled = true; stop(); unsub(); };
  }, [cwd, enabled]);

  return { stashes, refetch };
}
