// useLive — central live data hook. Subscribes to /stream SSE and refetches
// workers, daemon health, recents, and per-selection diff. The SSE event is
// only a "change" ping; clients must refetch /workers etc. to see deltas.
//
// Polling is the safety net (every 4s); SSE drives the fast path with an
// 80ms debounce.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { createReconnectingStream } from "../api/sse.js";

const POLL_MS = 4000;
const SSE_DEBOUNCE_MS = 80;

function extractLastUsage(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== "usage") continue;
    const p = typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload;
    if (p && (p.in != null || p.out != null)) return p;
  }
  return null;
}

export function useLive() {
  const [workers, setWorkers] = useState([]);
  const [health, setHealth] = useState(true);
  const [recents, setRecents] = useState([]);
  const [session, setSession] = useState(null);
  const [uiConfig, setUiConfig] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [lastUsage, setLastUsage] = useState(null);
  const lastUsageWorker = useRef(null);

  const refetchTimer = useRef(null);
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(async () => {
      refetchTimer.current = null;
      try {
        const [list, sess] = await Promise.all([api.listWorkers(), api.getSession()]);
        if (Array.isArray(list)) setWorkers(list);
        if (sess) setSession(sess);
      } catch { setHealth(false); }
    }, SSE_DEBOUNCE_MS);
  }, []);

  // initial load
  useEffect(() => {
    (async () => {
      try {
        const [list, sess, rec, cfg] = await Promise.all([
          api.listWorkers(),
          api.getSession(),
          api.listRecents(),
          api.uiConfig(),
        ]);
        if (Array.isArray(list)) setWorkers(list);
        if (sess) setSession(sess);
        setRecents(rec?.paths ?? []);
        setUiConfig(cfg);
        setHealth(true);
      } catch { setHealth(false); }
    })();
  }, []);

  // poll fallback
  useEffect(() => {
    const t = setInterval(scheduleRefetch, POLL_MS);
    return () => clearInterval(t);
  }, [scheduleRefetch]);

  // SSE
  useEffect(() => {
    const s = createReconnectingStream({
      onOpen: () => setHealth(true),
      onChange: () => scheduleRefetch(),
      onClose: () => setHealth(false),
    });
    return () => s.close();
  }, [scheduleRefetch]);

  // tick for elapsed counters
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // mutations -------------------------------------------------------------

  const refreshRecents = useCallback(async () => {
    const r = await api.listRecents();
    setRecents(r?.paths ?? []);
  }, []);

  const spawnOrchestrator = useCallback(async ({ name, cwd, model, effort } = {}) => {
    const r = await api.spawnOrchestrator({ name, cwd, model, effort });
    scheduleRefetch();
    refreshRecents();
    return r;
  }, [scheduleRefetch, refreshRecents]);

  const sendToAgent = useCallback(async (id, text) => {
    const worker = workers.find((w) => w.id === id);
    if (!worker) return { ok: false, status: 404, body: { error: "not found" } };
    const r = worker.is_orchestrator
      ? await api.sendOrchestratorMessage(id, text)
      : await api.sendWorkerMessage(id, text);
    scheduleRefetch();
    return r;
  }, [workers, scheduleRefetch]);

  const killAgent = useCallback(async (id) => {
    const r = await api.killWorker(id);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch]);

  const renameAgent = useCallback(async (id, name) => {
    const r = await api.renameWorker(id, name || null);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch]);

  const setPermissionMode = useCallback(async (id, mode) => {
    const r = await api.setWorkerPermission(id, mode);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch]);

  const setModel = useCallback(async (id, model, effort) => {
    const r = await api.setWorkerModel(id, model, effort);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch]);

  const updateLastUsage = useCallback(async (workerId) => {
    if (!workerId) { setLastUsage(null); return; }
    if (lastUsageWorker.current === workerId && lastUsage) return;
    try {
      const events = await api.getWorkerEvents(workerId, { order: "desc", limit: 50 });
      lastUsageWorker.current = workerId;
      setLastUsage(extractLastUsage(events));
    } catch { /* ignore */ }
  }, [lastUsage]);

  const refreshLastUsage = useCallback(async (workerId) => {
    if (!workerId) return;
    try {
      const events = await api.getWorkerEvents(workerId, { order: "desc", limit: 50 });
      lastUsageWorker.current = workerId;
      setLastUsage(extractLastUsage(events));
    } catch { /* ignore */ }
  }, []);

  const orchestrators = useMemo(() => workers.filter((w) => !!w.is_orchestrator), [workers]);

  return {
    workers,
    orchestrators,
    health,
    session,
    recents,
    uiConfig,
    now,
    spawnOrchestrator,
    sendToAgent,
    killAgent,
    renameAgent,
    setPermissionMode,
    setModel,
    refreshRecents,
    lastUsage,
    updateLastUsage,
    refreshLastUsage,
  };
}
