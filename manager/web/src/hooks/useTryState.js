import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";

const REFRESH_DEBOUNCE_MS = 800;

// Try lifecycle for the Changes panel. Tries stack per repo — Apply hides
// only while THIS worker has an active layer (the deck's Keep/Discard owns
// it) and FOREVER once this worker's try was KEPT; other workers' layers
// never block this worker's Apply button. try_applied/kept/discarded stamp
// worker ids in the SSE feed, so the debounced activity effect keeps the
// Apply button in step with the deck.
export function useTryState(workerId, isolated, live) {
  const [tryState, setTryState] = useState({ phase: "idle" });
  const [tryInfo, setTryInfo] = useState(null);
  useEffect(() => { setTryState({ phase: "idle" }); setTryInfo(null); }, [workerId]);

  const refreshTry = useCallback(async () => {
    if (!isolated) { setTryInfo(null); return; }
    setTryInfo(await api.getTryState(workerId));
  }, [workerId, isolated]);
  useEffect(() => { refreshTry(); }, [refreshTry]);

  const timerRef = useRef(null);
  useEffect(() => {
    if (live.eventSignal.workerId !== workerId) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(refreshTry, REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timerRef.current);
  }, [live.eventSignal.tick, live.eventSignal.workerId, workerId, refreshTry]);

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
          : b.reason === "active-try"
            ? "already applied in your checkout"
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
    applyTry,
  };
}
