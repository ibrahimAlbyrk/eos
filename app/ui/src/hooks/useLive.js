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
import { applyDescriptors, applyProfiles } from "../lib/backendCaps.js";
import { applyChunk, applyDone } from "../state/terminalStore.js";
import { emitPtyData, emitPtyExit } from "../state/ptyBus.js";
import { markExited } from "../state/ptyPanelStore.js";
import { applyDelta, dropWorker as dropThinking } from "../state/thinkingStore.js";
import { isRunning } from "../lib/agentActivity.js";
import { applyProgress as applyLoopCheck } from "../state/loopCheckStore.js";
import { cancelQueued, retract } from "../state/outboxStore.js";
import { setRecall } from "../state/recallStore.js";
import { explorer } from "../state/explorerStore.js";
import { emitGitChange } from "../state/gitChangeBus.js";
import { emitFsChange } from "../state/fsChangeBus.js";
import { resubscribe as resubscribeFileWatches } from "../state/fileWatchStore.js";

const POLL_MS = 4000;
const SSE_DEBOUNCE_MS = 80;

export function useLive() {
  const [workers, setWorkers] = useState([]);
  // True once the first /workers fetch has resolved. Lets consumers tell an
  // empty list that means "no workers" from one that just means "still loading"
  // — the difference that decides whether deleting the last agent should reset.
  const [loaded, setLoaded] = useState(false);
  const [health, setHealth] = useState(true);
  const [recents, setRecents] = useState([]);
  const [uiConfig, setUiConfig] = useState(null);
  const [update, setUpdate] = useState(null);
  const [eventSignal, setEventSignal] = useState({ tick: 0, workerId: null });
  const now = useClockTick();
  const [interruptedId, _setInterruptedId] = useState(() => localStorage.getItem("cm:interruptedId"));
  const setInterruptedId = useCallback((id) => {
    _setInterruptedId(id);
    if (id) localStorage.setItem("cm:interruptedId", id);
    else localStorage.removeItem("cm:interruptedId");
  }, []);

  // Monotonic guard for the workers snapshot. Every api.listWorkers() call takes
  // a sequence number when ISSUED; a resolved response is applied only if no
  // newer request has already landed. Without this a stale in-flight fetch can
  // resolve after a just-spawned worker's post-POST refresh and clobber the list
  // with a pre-spawn snapshot — nulling the caller's fresh selection downstream.
  const workersSeqRef = useRef(0);
  const appliedWorkersSeqRef = useRef(0);
  const applyWorkers = useCallback((seq, list) => {
    if (seq < appliedWorkersSeqRef.current) return false;
    appliedWorkersSeqRef.current = seq;
    setWorkers(list);
    setLoaded(true);
    return true;
  }, []);

  const setPendingPermissionsRef = useRef(null);
  const refetchTimer = useRef(null);
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) return;
    refetchTimer.current = setTimeout(async () => {
      refetchTimer.current = null;
      const seq = ++workersSeqRef.current;
      try {
        const [list, pend] = await Promise.all([api.listWorkers(), api.listPending().catch(() => [])]);
        if (Array.isArray(pend)) setPendingPermissionsRef.current?.(pend);
        if (Array.isArray(list) && applyWorkers(seq, list)) {
          const iid = localStorage.getItem("cm:interruptedId");
          if (iid) {
            const w = list.find((x) => x.id === iid);
            if (!w || w.state === "DONE" || w.state === "IDLE") setInterruptedId(null);
          }
        }
      } catch { setHealth(false); }
    }, SSE_DEBOUNCE_MS);
  }, [setInterruptedId, applyWorkers]);

  // initial load
  useEffect(() => {
    (async () => {
      const seq = ++workersSeqRef.current;
      try {
        const [list, rec, cfg] = await Promise.all([
          api.listWorkers(),
          api.listRecents(),
          api.uiConfig(),
        ]);
        if (Array.isArray(list)) applyWorkers(seq, list);
        setRecents(rec?.paths ?? []);
        applyCatalog(cfg?.modelCatalog);
        applyDescriptors(cfg?.backends);
        applyProfiles(cfg?.backendProfiles);
        setUiConfig(cfg);
        setHealth(true);
      } catch { setHealth(false); }
    })();
    // Update status rides its own fetch — a missing/old daemon endpoint must
    // never fail the main load.
    api.updateStatus().then((u) => u && setUpdate(u)).catch(() => {});
  }, []);

  // poll fallback
  useEffect(() => {
    const t = setInterval(scheduleRefetch, POLL_MS);
    return () => clearInterval(t);
  }, [scheduleRefetch]);

  // SSE
  useEffect(() => {
    const s = createReconnectingStream({
      onOpen: () => { setHealth(true); explorer.resubscribeWatches(); resubscribeFileWatches(); },
      onChange: (e) => {
        try {
          const data = JSON.parse(e.data);
          // A newer build appeared — refresh the banner status (not a worker delta).
          if (data.reason === "update:available") { api.updateStatus().then((u) => u && setUpdate(u)).catch(() => {}); return; }
          // Filesystem changes (Files tab) — surgically reconcile the affected
          // dir in the explorer store; not a worker delta, so skip the refetch.
          if (data.reason === "fs:change") { explorer.reconcileFsChange(data.payload ?? {}); emitFsChange(data.payload ?? {}); return; }
          // Git state changed on disk (commit / edit / checkout / stash, from any
          // source) — fan out to the dir-keyed git views; not a worker delta, so
          // no workers refetch.
          if (data.reason === "git:change") { emitGitChange(data.payload?.dir, data.payload?.kinds); return; }
          // Terminal chunks are high-frequency live data, not state deltas —
          // route them to the terminal store and skip the refetch entirely.
          if (data.reason === "terminal:chunk") { applyChunk(data.payload ?? {}); return; }
          if (data.reason === "terminal:done") applyDone(data.payload ?? {});
          // Interactive-PTY bytes/exit — high-frequency live data routed straight
          // to the matching xterm via ptyBus (seq dedup lives in TerminalView);
          // pty:exit also flags the tab. Not a worker delta, so skip the refetch.
          if (data.reason === "pty:data") { emitPtyData(data.payload ?? {}); return; }
          if (data.reason === "pty:exit") { const p = data.payload ?? {}; emitPtyExit(p); if (p.sessionId) markExited(p.sessionId); return; }
          // Live reasoning/text deltas (claude-sdk / in-process) — high-frequency
          // live data, not a state delta; route to the thinking store, skip refetch.
          if (data.reason === "agent:delta") { applyDelta(data.payload ?? {}); return; }
          // Transient goal-check progress (loop tick) — drive the live "checking"
          // indicator via the loop-check store; not a worker-state delta, so skip
          // the refetch. The durable verdict rides loop_check (a worker:change).
          if (data.reason === "loop:check") { applyLoopCheck(data.payload ?? {}); return; }
          // Recall (interrupt before the agent responded): drop the optimistic
          // bubble now + surface the text for the composer restore. The durable
          // message_recalled event (delivered as a worker:change below) hides the
          // server-side bubble via the Messages fold — so still refetch.
          if (data.reason === "message:recalled") {
            const p = data.payload ?? {};
            if (p.workerId) {
              retract(p.workerId, p.clientMsgId);
              // The owning pane's Composer consumes this once (recallStore) — no
              // selectedId detour, no re-inject on reselect/reconnect.
              setRecall(p.workerId, p.text ?? "");
            }
            return;
          }
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

  // Drop live reasoning/text buffers when a worker leaves the busy set — its turn
  // ended (or errored/aborted via the terminal turn event), so a partial or errored
  // turn's thinking line can't outlive the turn. A durable canonical block, when one
  // landed, already replaced the live buffer by blockId; this clears any orphan an
  // errored turn (no durable) left behind.
  const busyIdsRef = useRef(new Set());
  useEffect(() => {
    const nextBusy = new Set();
    for (const w of workers) if (isRunning(w)) nextBusy.add(w.id);
    for (const id of busyIdsRef.current) {
      if (!nextBusy.has(id)) dropThinking(id);
    }
    busyIdsRef.current = nextBusy;
  }, [workers]);

  // mutations -------------------------------------------------------------

  const refreshRecents = useCallback(async () => {
    const r = await api.listRecents();
    setRecents(r?.paths ?? []);
  }, []);

  const spawnOrchestrator = useCallback(async ({ name, cwd, model, effort, prompt, permissionMode, backendKind, backendProfile } = {}) => {
    const r = await api.spawnOrchestrator({ name, cwd, model, effort, prompt, permissionMode, backendKind, backendProfile });
    // Refresh workers synchronously so the new id is visible before the
    // caller sets it as selected — otherwise App.jsx's stale-selection
    // cleanup races with the caller and immediately clears the selection.
    try {
      const seq = ++workersSeqRef.current;
      const list = await api.listWorkers();
      if (Array.isArray(list)) applyWorkers(seq, list);
    } catch { /* fallback to scheduleRefetch */ }
    refreshRecents();
    return r;
  }, [refreshRecents, applyWorkers]);

  // workspaceOf attaches the git agent INSIDE an existing worker's worktree
  // (tree-level ops, direct file access); cwd is the checkout path otherwise.
  const spawnGitAgent = useCallback(async ({ cwd, prompt, name, workspaceOf, worktreeFrom, promptTemplate } = {}) => {
    const r = await api.spawnWorker({ role: "git", cwd, prompt, name: name ?? "git", workspaceOf, worktreeFrom, promptTemplate });
    // Same sync refresh as spawnOrchestrator — keeps the new id visible
    // before the caller selects it.
    try {
      const seq = ++workersSeqRef.current;
      const list = await api.listWorkers();
      if (Array.isArray(list)) applyWorkers(seq, list);
    } catch { /* fallback to scheduleRefetch */ }
    refreshRecents();
    return r;
  }, [refreshRecents, applyWorkers]);

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
    // Esc cancels what the user queued — the daemon clears its pending rows
    // before the IDLE transition; mirror that on the pills instantly.
    cancelQueued(id);
    const r = await api.interruptWorker(id);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch, setInterruptedId]);

  // Archive replaces the old hard delete for every UI entry point. The row
  // (and its subtree) leaves the next /workers payload, so downstream vanish
  // handling (prunePanes, selection cleanup, useStorePrune) is unchanged.
  const archiveAgent = useCallback(async (id) => {
    const r = await api.archiveWorker(id);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch]);

  const restoreAgent = useCallback(async (id) => {
    const r = await api.restoreWorker(id);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch]);

  const purgeAgent = useCallback(async (id) => {
    const r = await api.purgeWorker(id);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch]);

  // Permanent delete of a LIVE agent — menu-only and confirm-gated at the call
  // site; Cmd+W stays archive-only.
  const killAgent = useCallback(async (id) => {
    const r = await api.killWorker(id);
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
    // A 422 means the model isn't valid for the worker's provider (nothing
    // persisted) — surface it like the backend-switch rejection.
    if (!r.ok) console.warn("model switch failed", r.status, r.body);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch]);

  // Switch the worker's provider (stops + resumes under the new backend, reusing
  // the session). The daemon enforces handoff compatibility — surface a rejection.
  const switchBackend = useCallback(async (id, kind) => {
    const r = await api.switchWorkerBackend(id, kind);
    if (!r.ok) console.warn("backend switch failed", r.status, r.body);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch]);

  const applyUpdate = useCallback(async () => {
    const r = await api.applyUpdate(true);
    // Refused (disabled/not-available) → refresh so the banner reflects it; on
    // success the app shell relaunches once the rebuilt daemon is up.
    if (!r.ok || r.body?.started === false) api.updateStatus().then((u) => u && setUpdate(u)).catch(() => {});
    return r.body ?? { started: r.ok };
  }, []);
  const deferUpdate = useCallback(async () => {
    setUpdate((u) => (u ? { ...u, deferred: true } : u));
    await api.deferUpdate();
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
    loaded,
    health,
    recents,
    uiConfig,
    now,
    spawnOrchestrator,
    spawnGitAgent,
    sendToAgent,
    interruptAgent,
    archiveAgent,
    restoreAgent,
    purgeAgent,
    killAgent,
    renameAgent,
    setPermissionMode,
    setModel,
    switchBackend,
    refreshRecents,
    interruptedId,
    pendingPermissions,
    approvePending,
    alwaysAllowPending,
    denyPending,
    update,
    applyUpdate,
    deferUpdate,
    eventSignal,
  };
}
