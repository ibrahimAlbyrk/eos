import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";
import { subscribeGitChange, TRY_KINDS } from "../state/gitChangeBus.js";
import { workerGitDir } from "../lib/workerGitDir.js";

const REFRESH_DEBOUNCE_MS = 800;

// Try lifecycle for the Changes panel. Apply is idempotent: the first click
// applies the worker's changes, later clicks RE-SYNC only the new delta (after
// the worker fixed a bug in its worktree). So the button is gated on `syncable`
// — does the worktree have changes not yet in the checkout — not on whether the
// work was ever applied/kept. Two signals feed the refresh: apply/keep/discard
// ride worker:change → eventSignal, while the worktree advancing (which moves
// `syncable`) rides git:change — so the button stays in step with edits from any
// source, not just the agent's own turns.
export function useTryState(workerId, isolated, live) {
  const [tryState, setTryState] = useState({ phase: "idle" });
  const [tryInfo, setTryInfo] = useState(null);
  useEffect(() => { setTryState({ phase: "idle" }); setTryInfo(null); }, [workerId]);

  const refreshTry = useCallback(async () => {
    if (!isolated) { setTryInfo(null); return; }
    setTryInfo(await api.getTryState(workerId));
  }, [workerId, isolated]);
  useEffect(() => { refreshTry(); }, [refreshTry]);

  const gitDir = workerGitDir(live.workers.find((w) => w.id === workerId));

  const timerRef = useRef(null);
  const debouncedRefresh = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(refreshTry, REFRESH_DEBOUNCE_MS);
  }, [refreshTry]);

  useEffect(() => {
    if (live.eventSignal.workerId !== workerId) return;
    debouncedRefresh();
    return () => clearTimeout(timerRef.current);
  }, [live.eventSignal.tick, live.eventSignal.workerId, workerId, debouncedRefresh]);

  useEffect(() => {
    if (!isolated || !gitDir) return;
    return subscribeGitChange(gitDir, TRY_KINDS, debouncedRefresh);
  }, [isolated, gitDir, debouncedRefresh]);

  // Apply is one click — tryApply re-validates everything server-side
  // (snapshot → virtual merge over the stack → conflict + dirty-file checks)
  // and writes only when all pass; failures come back as structured reasons
  // with nothing half-applied. Conflicts flip the button to the git-agent
  // escalation; conflicts with another layer point at that layer instead.
  const applyTry = useCallback(async () => {
    setTryState({ phase: "applying" });
    const r = await api.tryApply(workerId);
    if (r.ok) { setTryState({ phase: "idle" }); await refreshTry(); return; }
    const b = r.body ?? {};
    if (b.reason === "conflicts") { setTryState({ phase: "conflicts", count: b.files?.length ?? 0 }); return; }
    setTryState({
      phase: "error",
      msg: b.reason === "dirty-files"
        ? `your checkout has local edits in ${(b.files ?? []).slice(0, 3).join(", ")}${(b.files?.length ?? 0) > 3 ? "…" : ""}`
        : b.reason === "conflicts-with-try"
          ? "conflicts with another active try — keep/discard it first"
          : b.reason === "blocked-by-overlay"
            ? "a try on top touches these files — keep/discard it first"
            : b.reason === "nothing-to-apply"
              ? "nothing to apply"
              : b.reason === "unsupported"
                ? "needs git >= 2.38"
                : b.error ?? b.detail ?? b.reason ?? "failed",
    });
  }, [workerId, refreshTry]);

  const activeTries = tryInfo?.activeTries ?? [];
  return {
    tryState,
    activeTries,
    // This worker's own layer is live in the user's checkout.
    appliedHere: activeTries.some((t) => t.workerId === workerId),
    kept: Boolean(tryInfo?.kept),
    // The worktree advanced past what is applied/kept — Apply re-syncs the delta.
    syncable: Boolean(tryInfo?.syncable),
    syncFiles: tryInfo?.syncFiles ?? [],
    applyTry,
  };
}
