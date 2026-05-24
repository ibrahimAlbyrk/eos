import { createContext, useCallback, useContext, useMemo, useState } from "react";

const NotificationContext = createContext(null);

const sigOf = (w) => `${(w.tokens_in ?? 0) + (w.tokens_out ?? 0)}|${w.tool_calls ?? 0}|${w.cost_usd ?? 0}`;

export function NotificationProvider({ children }) {
  const [viewedSignatures, setViewedSignatures] = useState(() => new Map());

  const markViewed = useCallback((worker) => {
    if (!worker || !worker.id) return;
    const sig = sigOf(worker);
    setViewedSignatures((prev) => {
      if (prev.get(worker.id) === sig) return prev;
      const next = new Map(prev);
      next.set(worker.id, sig);
      return next;
    });
  }, []);

  const seedViewed = useCallback((worker) => {
    if (!worker || !worker.id) return;
    setViewedSignatures((prev) => {
      if (prev.has(worker.id)) return prev;
      const next = new Map(prev);
      next.set(worker.id, sigOf(worker));
      return next;
    });
  }, []);

  const hasNewActivity = useCallback((worker) => {
    if (!worker || !worker.id) return false;
    const seen = viewedSignatures.get(worker.id);
    if (!seen) return false;
    return seen !== sigOf(worker);
  }, [viewedSignatures]);

  const value = useMemo(() => ({
    markViewed, seedViewed, hasNewActivity,
  }), [markViewed, seedViewed, hasNewActivity]);

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotification() {
  const c = useContext(NotificationContext);
  if (!c) throw new Error("useNotification outside NotificationProvider");
  return c;
}
