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
  const [pendingPermissions, setPendingPermissions] = useState([]);
  const [eventSignal, setEventSignal] = useState({ tick: 0, workerId: null });
  const [now, setNow] = useState(Date.now());
  const [lastUsage, setLastUsage] = useState(null);
  const lastUsageWorker = useRef(null);
  const [interruptedId, _setInterruptedId] = useState(() => localStorage.getItem("cm:interruptedId"));
  const setInterruptedId = useCallback((id) => {
    _setInterruptedId(id);
    if (id) localStorage.setItem("cm:interruptedId", id);
    else localStorage.removeItem("cm:interruptedId");
  }, []);

  const refetchTimer = useRef(null);
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(async () => {
      refetchTimer.current = null;
      try {
        const [list, sess, pend] = await Promise.all([api.listWorkers(), api.getSession(), api.listPending().catch(() => [])]);
        if (Array.isArray(pend)) setPendingPermissions(pend);
        if (Array.isArray(list)) {
          setWorkers(list);
          const iid = localStorage.getItem("cm:interruptedId");
          if (iid) {
            const w = list.find((x) => x.id === iid);
            if (!w || w.state === "DONE" || w.state === "IDLE") setInterruptedId(null);
          }
        }
        if (sess) setSession(sess);
      } catch { setHealth(false); }
    }, SSE_DEBOUNCE_MS);
  }, [setInterruptedId]);

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
      onChange: (e) => {
        scheduleRefetch();
        try {
          const data = JSON.parse(e.data);
          if (data.payload?.workerId) {
            setEventSignal(prev => ({ tick: prev.tick + 1, workerId: data.payload.workerId }));
          }
        } catch {}
      },
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

  const spawnOrchestrator = useCallback(async ({ name, cwd, model, effort, prompt } = {}) => {
    const r = await api.spawnOrchestrator({ name, cwd, model, effort, prompt });
    scheduleRefetch();
    refreshRecents();
    return r;
  }, [scheduleRefetch, refreshRecents]);

  const workersRef = useRef(workers);
  workersRef.current = workers;

  const sendToAgent = useCallback(async (id, text) => {
    setInterruptedId(null);
    const worker = workersRef.current.find((w) => w.id === id);
    if (!worker) return { ok: false, status: 404, body: { error: "not found" } };
    const r = worker.is_orchestrator
      ? await api.sendOrchestratorMessage(id, text)
      : await api.sendWorkerMessage(id, text);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch, setInterruptedId]);

  const interruptAgent = useCallback(async (id) => {
    setInterruptedId(id);
    const r = await api.interruptWorker(id);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch, setInterruptedId]);

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

  const lastUsageRef = useRef(null);
  const updateLastUsage = useCallback(async (workerId) => {
    if (!workerId) { setLastUsage(null); lastUsageRef.current = null; return; }
    if (lastUsageWorker.current === workerId && lastUsageRef.current) return;
    try {
      const events = await api.getWorkerEvents(workerId, { order: "desc", limit: 50 });
      lastUsageWorker.current = workerId;
      const usage = extractLastUsage(events);
      lastUsageRef.current = usage;
      setLastUsage(usage);
    } catch { /* ignore */ }
  }, []);

  const refreshLastUsage = useCallback(async (workerId) => {
    if (!workerId) return;
    try {
      const events = await api.getWorkerEvents(workerId, { order: "desc", limit: 50 });
      lastUsageWorker.current = workerId;
      setLastUsage(extractLastUsage(events));
    } catch { /* ignore */ }
  }, []);

  const approvePending = useCallback(async (id) => {
    await api.approvePending(id);
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
    scheduleRefetch();
  }, [scheduleRefetch]);

  const alwaysAllowPending = useCallback(async (id, toolName, _workerId) => {
    await api.approvePending(id);
    await api.addPolicyRule(toolName, "allow").catch(() => {});
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
    scheduleRefetch();
  }, [scheduleRefetch]);

  const denyPending = useCallback(async (id, reason) => {
    await api.denyPending(id, reason);
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
    scheduleRefetch();
  }, [scheduleRefetch]);

  const effectiveWorkers = useMemo(() => {
    if (!interruptedId) return workers;
    return workers.map((w) => w.id === interruptedId ? { ...w, state: "IDLE" } : w);
  }, [workers, interruptedId]);

  const orchestrators = useMemo(() => effectiveWorkers.filter((w) => !!w.is_orchestrator), [effectiveWorkers]);

  return {
    workers: effectiveWorkers,
    orchestrators,
    health,
    session,
    recents,
    uiConfig,
    now,
    spawnOrchestrator,
    sendToAgent,
    interruptAgent,
    killAgent,
    renameAgent,
    setPermissionMode,
    setModel,
    refreshRecents,
    lastUsage,
    updateLastUsage,
    refreshLastUsage,
    interruptedId,
    pendingPermissions,
    approvePending,
    alwaysAllowPending,
    denyPending,
    eventSignal,
  };
}
