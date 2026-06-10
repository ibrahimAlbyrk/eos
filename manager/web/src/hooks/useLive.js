// useLive — central live data hook. Subscribes to /stream SSE and refetches
// workers, daemon health, recents, and per-selection diff. The SSE event is
// only a "change" ping; clients must refetch /workers etc. to see deltas.
//
// Polling is the safety net (every 4s); SSE drives the fast path with an
// 80ms debounce.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { createReconnectingStream } from "../api/sse.js";
import { useClockTick } from "./useClockTick.js";
import { usePendingPermissions } from "./usePendingPermissions.js";
import { applyCatalog } from "../lib/models.js";
import { applyChunk, applyDone } from "../state/terminalStore.js";

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
  const [uiConfig, setUiConfig] = useState(null);
  const [eventSignal, setEventSignal] = useState({ tick: 0, workerId: null });
  const now = useClockTick();
  const [lastUsage, setLastUsage] = useState(null);
  const lastUsageWorker = useRef(null);
  const [interruptedId, _setInterruptedId] = useState(() => localStorage.getItem("cm:interruptedId"));
  const setInterruptedId = useCallback((id) => {
    _setInterruptedId(id);
    if (id) localStorage.setItem("cm:interruptedId", id);
    else localStorage.removeItem("cm:interruptedId");
  }, []);

  const setPendingPermissionsRef = useRef(null);
  const refetchTimer = useRef(null);
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(async () => {
      refetchTimer.current = null;
      try {
        const [list, pend] = await Promise.all([api.listWorkers(), api.listPending().catch(() => [])]);
        if (Array.isArray(pend)) setPendingPermissionsRef.current?.(pend);
        if (Array.isArray(list)) {
          setWorkers(list);
          const iid = localStorage.getItem("cm:interruptedId");
          if (iid) {
            const w = list.find((x) => x.id === iid);
            if (!w || w.state === "DONE" || w.state === "IDLE") setInterruptedId(null);
          }
        }
      } catch { setHealth(false); }
    }, SSE_DEBOUNCE_MS);
  }, [setInterruptedId]);

  // initial load
  useEffect(() => {
    (async () => {
      try {
        const [list, rec, cfg] = await Promise.all([
          api.listWorkers(),
          api.listRecents(),
          api.uiConfig(),
        ]);
        if (Array.isArray(list)) setWorkers(list);
        setRecents(rec?.paths ?? []);
        applyCatalog(cfg?.modelCatalog);
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
        try {
          const data = JSON.parse(e.data);
          // eos build rebuilt the web dist — reload in place so the running
          // app picks up the new assets without a quit/reopen.
          if (data.reason === "ui:reload") { window.location.reload(); return; }
          // Terminal chunks are high-frequency live data, not state deltas —
          // route them to the terminal store and skip the refetch entirely.
          if (data.reason === "terminal:chunk") { applyChunk(data.payload ?? {}); return; }
          if (data.reason === "terminal:done") applyDone(data.payload ?? {});
          scheduleRefetch();
          if (data.payload?.workerId) {
            setEventSignal(prev => ({ tick: prev.tick + 1, workerId: data.payload.workerId }));
          }
        } catch {
          scheduleRefetch();
        }
      },
      onClose: () => setHealth(false),
    });
    return () => s.close();
  }, [scheduleRefetch]);

  // mutations -------------------------------------------------------------

  const refreshRecents = useCallback(async () => {
    const r = await api.listRecents();
    setRecents(r?.paths ?? []);
  }, []);

  const spawnOrchestrator = useCallback(async ({ name, cwd, model, effort, prompt, permissionMode } = {}) => {
    const r = await api.spawnOrchestrator({ name, cwd, model, effort, prompt, permissionMode });
    // Refresh workers synchronously so the new id is visible before the
    // caller sets it as selected — otherwise App.jsx's stale-selection
    // cleanup races with the caller and immediately clears the selection.
    try {
      const list = await api.listWorkers();
      if (Array.isArray(list)) setWorkers(list);
    } catch { /* fallback to scheduleRefetch */ }
    refreshRecents();
    return r;
  }, [refreshRecents]);

  // workspaceOf attaches the git agent INSIDE an existing worker's worktree
  // (tree-level ops, direct file access); cwd is the checkout path otherwise.
  const spawnGitAgent = useCallback(async ({ cwd, prompt, name, workspaceOf } = {}) => {
    const r = await api.spawnWorker({ role: "git", cwd, prompt, name: name ?? "git", workspaceOf });
    // Same sync refresh as spawnOrchestrator — keeps the new id visible
    // before the caller selects it.
    try {
      const list = await api.listWorkers();
      if (Array.isArray(list)) setWorkers(list);
    } catch { /* fallback to scheduleRefetch */ }
    refreshRecents();
    return r;
  }, [refreshRecents]);

  const workersRef = useRef(workers);
  workersRef.current = workers;

  const sendToAgent = useCallback(async (id, text, { clientMsgId, queueWhenBusy } = {}) => {
    setInterruptedId(null);
    const worker = workersRef.current.find((w) => w.id === id);
    if (!worker) return { ok: false, status: 404, body: { error: "not found" } };
    const opts = { clientMsgId, queueWhenBusy };
    const r = worker.is_orchestrator
      ? await api.sendOrchestratorMessage(id, text, opts)
      : await api.sendWorkerMessage(id, text, opts);
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

  const resumeAgent = useCallback(async (id) => {
    const r = await api.resumeWorker(id);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch]);

  const renameAgent = useCallback(async (id, name) => {
    // Optimistic — avoid flashing the old name between input close and
    // the refetch landing.
    setWorkers((prev) => prev.map((w) => w.id === id ? { ...w, name } : w));
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

  const {
    pendingPermissions,
    setPendingPermissions,
    approvePending,
    alwaysAllowPending,
    denyPending,
  } = usePendingPermissions(scheduleRefetch);
  setPendingPermissionsRef.current = setPendingPermissions;

  const effectiveWorkers = useMemo(() => {
    if (!interruptedId) return workers;
    return workers.map((w) => w.id === interruptedId ? { ...w, state: "IDLE" } : w);
  }, [workers, interruptedId]);

  const orchestrators = useMemo(() => effectiveWorkers.filter((w) => !!w.is_orchestrator), [effectiveWorkers]);

  return {
    workers: effectiveWorkers,
    orchestrators,
    health,
    recents,
    uiConfig,
    now,
    spawnOrchestrator,
    spawnGitAgent,
    sendToAgent,
    interruptAgent,
    killAgent,
    resumeAgent,
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
