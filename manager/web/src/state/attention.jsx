import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { needsAttention as policyNeedsAttention, sigOf } from "../lib/agentAttention.js";

// Attention state — tracks, per worker, the activity signature the user last
// viewed. Whether the blue dot shows is DERIVED from (state, signature, last
// viewed signature) on every render — see lib/agentAttention.js — so no
// WORKING→IDLE transition can be missed between polls.

const AttentionContext = createContext(null);

export function AttentionProvider({ children }) {
  const [viewedSigs, setViewedSigs] = useState(() => new Map());

  // Seed unseen workers, keep the selected one in sync, and prune entries
  // for workers that no longer exist — one pass per workers update.
  const syncWorkers = useCallback((workers, selectedId) => {
    setViewedSigs((prev) => {
      let next = null;
      const ids = new Set();
      for (const w of workers) {
        if (!w || !w.id) continue;
        ids.add(w.id);
        const shouldSync = w.id === selectedId || !prev.has(w.id);
        if (!shouldSync) continue;
        const sig = sigOf(w);
        if (prev.get(w.id) === sig) continue;
        next ??= new Map(prev);
        next.set(w.id, sig);
      }
      for (const id of prev.keys()) {
        if (ids.has(id)) continue;
        next ??= new Map(prev);
        next.delete(id);
      }
      return next ?? prev;
    });
  }, []);

  const needsAttention = useCallback((worker) => {
    if (!worker || !worker.id) return false;
    return policyNeedsAttention(viewedSigs.get(worker.id), worker);
  }, [viewedSigs]);

  const value = useMemo(() => ({
    needsAttention, syncWorkers,
  }), [needsAttention, syncWorkers]);

  return <AttentionContext.Provider value={value}>{children}</AttentionContext.Provider>;
}

export function useAttention() {
  const c = useContext(AttentionContext);
  if (!c) throw new Error("useAttention outside AttentionProvider");
  return c;
}

// Single bookkeeping point — called once at the app shell so attention
// tracking keeps running no matter which view is active.
export function useAttentionSync(workers, selectedId) {
  const { syncWorkers } = useAttention();
  useEffect(() => {
    if (workers.length === 0) return;
    syncWorkers(workers, selectedId);
  }, [workers, selectedId, syncWorkers]);
}
