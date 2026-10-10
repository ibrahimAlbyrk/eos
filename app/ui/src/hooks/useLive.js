// useLive — central live data hook. Subscribes to /stream SSE and keeps
// workers, pending asks, daemon health, recents current. A daemon that offers
// "state:patch" sends the changed rows themselves; an older one only pings, and
// the lists are refetched (80ms debounce, one request at a time).
//
// Polling is the safety net (every 4s, 30s while the stream is up).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.js";
import { createReconnectingStream } from "../api/sse.js";
import { useClockTick } from "./useClockTick.js";
import { usePendingPermissions } from "./usePendingPermissions.js";
import { applyCatalog } from "../lib/models.js";
import { applyDescriptors, applyProfiles } from "../lib/backendCaps.js";
import { applyChunk, applyDone } from "../state/terminalStore.js";
import { emitPtyData, emitPtyExit, emitPtyResync } from "../state/ptyBus.js";
import { markExited } from "../state/ptyPanelStore.js";
import { adoptRemote } from "../state/codeWorkspaceStore.js";
import { applyTabs as applyBrowserTabs, applyStatus as applyBrowserStatus } from "../state/browserPanelStore.js";
import { applyActivity as applyBrowserActivity } from "../state/browserSessionState.js";
import { updateAgentIndex, updateAgentNames } from "../lib/agentIndex.js";
import { applyDelta, dropInterrupted as dropInterruptedThinking, finalizeWorker as finalizeThinking } from "../state/thinkingStore.js";
import { isRunning } from "../lib/agentActivity.js";
import { subtreeIds } from "../lib/tree.js";
import { applyProgress as applyLoopCheck } from "../state/loopCheckStore.js";
import { cancelQueued, retract } from "../state/outboxStore.js";
import { setRecall } from "../state/recallStore.js";
import { explorer } from "../state/explorerStore.js";
import { emitGitChange, resubscribeGitWatches } from "../state/gitChangeBus.js";
import { emitFsChange } from "../state/fsChangeBus.js";
import { notify } from "../lib/notify.js";
import { resubscribe as resubscribeFileWatches } from "../state/fileWatchStore.js";
import { startPolling } from "../lib/pollInterval.js";
import { isViewHidden, onViewVisibilityChange } from "../lib/viewVisibility.js";
import { isRemoteView } from "../lib/host.js";
import { focusQuery } from "../state/streamFocus.js";
import { mergeRowChanges } from "../lib/rowPatches.js";
import { refreshArchived } from "../state/archiveStore.js";
import { setStreamLive } from "../state/streamStatus.js";
import { notifyWorkerChanged, refreshAttached as refreshAttachedTranscripts } from "../state/eventsStore.js";
import { refreshHosts } from "../state/hostsStore.js";
import { applyPresence } from "../state/peerStore.js";
import { applyChange as applyPageChange, resyncPages } from "../state/pagesStore.js";
import { applyProfileChange, resyncProfile } from "../state/profileStore.js";
import { applyUserMemoryChange, resyncUserMemories } from "../state/userMemoryStore.js";
import { applyDreamChange, resyncDreams } from "../state/dreamStore.js";
import { applySyncChange, resyncSync } from "../state/syncStore.js";
import { applyTransferChange, resyncTransfers } from "../state/transfersStore.js";
import { applyGenuiDelta, endWorker as endGenuiStreams, resyncGenuiStreams } from "../genui/streamStore.js";
import { applyViewStateChange, resyncViewStates } from "../genui/runtime/viewStateStore.js";

const POLL_MS = 4000;
// While the event stream is up it already triggers every refetch; the poll is
// then only a safety net — and over a peer link each tick is a full list.
const STREAM_LIVE_POLL_MS = 30_000;
const SSE_DEBOUNCE_MS = 80;
// Topics whose list changes arrive as state:patch rows — no refetch for them.
// policy:decision changes neither list (an ask arrives as pending:created).
const PATCHED_TOPICS = new Set([
  "worker:change", "worker:spawn", "worker:exit", "worker:removed", "usage:recorded", "loop:change",
  "pending:created", "pending:resolved", "pending:ttl_expired", "policy:decision",
]);
const HIDDEN_PAUSE_MS = 10_000;

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
  // The interrupted turn's turn_started_at rides along so the refetch clear can
  // detect a restart (queue drain) that skipped the observable IDLE window.
  const setInterruptedId = useCallback((id, turnStartedAt) => {
    _setInterruptedId(id);
    if (id) {
      localStorage.setItem("cm:interruptedId", id);
      if (turnStartedAt != null) localStorage.setItem("cm:interruptedTurn", String(turnStartedAt));
      else localStorage.removeItem("cm:interruptedTurn");
    } else {
      localStorage.removeItem("cm:interruptedId");
      localStorage.removeItem("cm:interruptedTurn");
    }
  }, []);

  // Monotonic guard for the workers snapshot. Every api.listWorkers() call takes
  // a sequence number when ISSUED; a resolved response is applied only if no
  // newer request has already landed. Without this a stale in-flight fetch can
  // resolve after a just-spawned worker's post-POST refresh and clobber the list
  // with a pre-spawn snapshot — nulling the caller's fresh selection downstream.
  const workersSeqRef = useRef(0);
  const appliedWorkersSeqRef = useRef(0);
  // The last applied list, synchronously — patches landing in one tick build on each other.
  const latestWorkersRef = useRef([]);
  const applyWorkers = useCallback((seq, list) => {
    if (seq < appliedWorkersSeqRef.current) return false;
    appliedWorkersSeqRef.current = seq;
    latestWorkersRef.current = list;
    // Keep the id -> parent_id session index (and id -> name, for session labels
    // like the present-fallback toast) in step with the snapshot, for non-React
    // consumers (browser session routing, pane transitions).
    updateAgentIndex(list);
    updateAgentNames(list);
    setWorkers(list);
    setLoaded(true);
    return true;
  }, []);

  // The interrupted agent left its turn: drop the optimistic IDLE mapping.
  const settleInterrupted = useCallback((list) => {
    const iid = localStorage.getItem("cm:interruptedId");
    if (!iid) return;
    const w = list.find((x) => x.id === iid);
    // A busy worker on a NEWER turn than the one we interrupted means the
    // queue drain restarted it before any refetch saw IDLE — the interrupt
    // completed, so the optimistic mapping must clear or Esc goes dead.
    const turn = localStorage.getItem("cm:interruptedTurn");
    const newerTurn = turn != null && w?.turn_started_at != null && String(w.turn_started_at) !== turn;
    if (!w || w.state === "DONE" || w.state === "IDLE" || newerTurn) setInterruptedId(null);
  }, [setInterruptedId]);

  const setPendingPermissionsRef = useRef(null);
  const refetchTimer = useRef(null);
  const streamLiveRef = useRef(false);
  const lastRefetchAtRef = useRef(0);
  // One list refetch at a time: over a slow link a burst of pings would stack
  // requests whose answers are thrown away anyway. A ping during one queues one more.
  const refetchInFlightRef = useRef(false);
  const refetchAgainRef = useRef(false);
  const scheduleRefetchRef = useRef(() => {});
  const scheduleRefetch = useCallback(() => {
    if (refetchTimer.current) return;
    if (refetchInFlightRef.current) { refetchAgainRef.current = true; return; }
    refetchTimer.current = setTimeout(async () => {
      refetchTimer.current = null;
      refetchInFlightRef.current = true;
      lastRefetchAtRef.current = Date.now();
      const seq = ++workersSeqRef.current;
      try {
        const [list, pend] = await Promise.all([api.listWorkers(), api.listPending().catch(() => [])]);
        if (Array.isArray(pend)) setPendingPermissionsRef.current?.(pend);
        if (Array.isArray(list) && applyWorkers(seq, list)) settleInterrupted(list);
      } catch { setHealth(false); }
      finally {
        refetchInFlightRef.current = false;
        if (refetchAgainRef.current) { refetchAgainRef.current = false; scheduleRefetchRef.current(); }
      }
    }, SSE_DEBOUNCE_MS);
  }, [settleInterrupted, applyWorkers]);
  scheduleRefetchRef.current = scheduleRefetch;

  // Row changes pushed by the daemon (state:patch). Taking a fresh seq also
  // discards an older full-list fetch still in flight.
  const patchesRef = useRef(false);
  const noteCaps = useCallback((d) => {
    patchesRef.current = Array.isArray(d?.caps) && d.caps.includes("state:patch");
  }, []);
  const applyStatePatch = useCallback((changes) => {
    if (!Array.isArray(changes)) return;
    if (changes.some((c) => c?.resource === "workers")) {
      const list = mergeRowChanges(latestWorkersRef.current, changes, "workers");
      if (applyWorkers(++workersSeqRef.current, list)) settleInterrupted(list);
    }
    if (changes.some((c) => c?.resource === "pending")) {
      setPendingPermissionsRef.current?.((prev) => mergeRowChanges(prev, changes, "pending"));
    }
  }, [applyWorkers, settleInterrupted]);

  // initial load
  useEffect(() => {
    (async () => {
      const seq = ++workersSeqRef.current;
      try {
        const [list, rec, cfg, pend] = await Promise.all([
          api.listWorkers(),
          api.listRecents(),
          api.uiConfig(),
          api.listPending().catch(() => null),
        ]);
        if (Array.isArray(list)) applyWorkers(seq, list);
        if (Array.isArray(pend)) setPendingPermissionsRef.current?.(pend);
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
    return startPolling(() => {
      if (!streamLiveRef.current || Date.now() - lastRefetchAtRef.current >= STREAM_LIVE_POLL_MS) scheduleRefetch();
    }, POLL_MS);
  }, [scheduleRefetch]);

  // SSE
  useEffect(() => {
    const s = createReconnectingStream({
      query: focusQuery,
      onOpen: () => { streamLiveRef.current = true; setStreamLive(true); setHealth(true); explorer.resubscribeWatches(); resubscribeFileWatches(); resubscribeGitWatches(); },
      onHello: noteCaps,
      // The daemon could not replay what this client missed (it restarted, or
      // the gap outgrew its buffer): refetch every live view from scratch.
      onResync: (d) => {
        noteCaps(d);
        scheduleRefetch();
        refreshAttachedTranscripts();
        setEventSignal((prev) => ({ tick: prev.tick + 1, workerId: null }));
        emitPtyResync();
        resyncPages();
        resyncProfile();
        resyncUserMemories();
        resyncDreams();
        resyncSync();
        if (!isRemoteView()) resyncTransfers();
        resyncViewStates();
        resyncGenuiStreams();
      },
      onChange: (e) => {
        try {
          const data = JSON.parse(e.data);
          // A newer build appeared — refresh the banner status (not a worker delta).
          if (data.reason === "update:available") { api.updateStatus().then((u) => u && setUpdate(u)).catch(() => {}); return; }
          if (data.reason === "state:patch") { applyStatePatch(data.payload?.changes); return; }
          // Peering: a controlled computer's link changed (Machines menu), or a
          // computer connected to / left this Mac (the "… connected" chip).
          if (data.reason === "hosts:change") { if (!window.eosHosts) void refreshHosts(); return; }
          if (data.reason === "peer:presence") { applyPresence(data.payload); return; }
          // A page was written (by the user elsewhere or an agent) — open editors
          // and page lists refetch; not a worker delta.
          if (data.reason === "pages:change") { applyPageChange(data.payload); return; }
          // The profile changed (another window, the interview) — avatar, menu
          // and Settings › Profile refetch; not a worker delta.
          if (data.reason === "profile:change") { applyProfileChange(data.payload); return; }
          // A memory was suggested or changed — Memory view + pending dot refetch.
          if (data.reason === "user-memory:change") { applyUserMemoryChange(); return; }
          // A dream started, moved on or finished — status, rail and log refetch.
          if (data.reason === "dream:change") { applyDreamChange(data.payload); return; }
          // Sync's status changed — Settings › Sync renders the payload as is.
          if (data.reason === "sync:change") { applySyncChange(data.payload); return; }
          // A file transfer moved on. A view of another Mac hears that Mac's
          // engine here, not ours — its transfers come through the shell's bridge.
          if (data.reason === "transfer:change") { if (!isRemoteView()) applyTransferChange(data.payload); return; }
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
          // PTY metadata / a claude pane's transcript changed — not worker deltas.
          // A session opened from a paired phone lands in the Code workspace.
          if (data.reason === "pty:session") { adoptRemote(data.payload); return; }
          if (data.reason === "pty:conversation") return;
          // Browser panel: the daemon's tab lists (per session) and engine
          // lifecycle. Panel state, not a worker delta — route to the session-
          // keyed browser store and skip the refetch. Frames never come this way.
          if (data.reason === "browser:tabs") { applyBrowserTabs(data.payload ?? {}); return; }
          if (data.reason === "browser:status") { applyBrowserStatus(data.payload); return; }
          // An agent used (tab/navigate) or presented (browser_show) its
          // session's browser — badge/auto-open rules live in the session store.
          if (data.reason === "browser:activity") { applyBrowserActivity(data.payload ?? {}); return; }
          // Live reasoning/text deltas (claude / in-process) — high-frequency
          // live data, not a state delta; route to the thinking store, skip refetch.
          if (data.reason === "agent:delta") { applyDelta(data.payload ?? {}); return; }
          // A visual answer being written (claude SDK lane): its tool input grows
          // in the genui stream store; the durable tool call replaces it.
          if (data.reason === "genui:delta") { applyGenuiDelta(data.payload ?? {}); return; }
          // A view's state changed (another window, the side-panel copy).
          if (data.reason === "genui:change") { applyViewStateChange(data.payload ?? {}); return; }
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
          if (!(patchesRef.current && PATCHED_TOPICS.has(data.reason))) scheduleRefetch();
          if (data.payload?.workerId) {
            // Straight to the transcript store: the signal below is React state,
            // and two workers' events in one render batch keep only the last.
            notifyWorkerChanged(data.payload.workerId);
            setEventSignal(prev => ({ tick: prev.tick + 1, workerId: data.payload.workerId }));
          }
        } catch {
          scheduleRefetch();
        }
      },
      onClose: () => { streamLiveRef.current = false; setStreamLive(false); setHealth(false); },
      onPause: () => { streamLiveRef.current = false; setStreamLive(false); },
    });
    // A view of another computer streams over the link to it: off screen for a
    // while (another machine shown, window minimized), it drops the stream;
    // back on screen it resumes from where it stopped. Quick switches keep it.
    let pauseTimer = null;
    const offVisibility = isRemoteView() ? onViewVisibilityChange(() => {
      if (!isViewHidden()) {
        clearTimeout(pauseTimer);
        pauseTimer = null;
        s.resume();
      } else if (!pauseTimer) {
        pauseTimer = setTimeout(() => { pauseTimer = null; s.pause(); }, HIDDEN_PAUSE_MS);
      }
    }) : null;
    return () => {
      offVisibility?.();
      clearTimeout(pauseTimer);
      s.close();
    };
  }, [scheduleRefetch, noteCaps, applyStatePatch]);

  // Finalize live reasoning/text buffers when a worker leaves the busy set — its
  // turn ended (or was interrupted/errored) with no durable block coming for the
  // partial stream. Finalizing KEEPS the streamed text visible in the transcript
  // (marked done+interrupted) instead of destroying it; stale finalized buffers
  // drop at the next turn start (sendToAgent below, or the thinking store's
  // new-block sweep for agent-plane turns). A durable canonical block, when one
  // landed, already replaced its live buffer by blockId.
  const busyIdsRef = useRef(new Set());
  useEffect(() => {
    const nextBusy = new Set();
    for (const w of workers) if (isRunning(w)) nextBusy.add(w.id);
    for (const id of busyIdsRef.current) {
      if (!nextBusy.has(id)) {
        finalizeThinking(id);
        endGenuiStreams(id);
      }
    }
    busyIdsRef.current = nextBusy;
  }, [workers]);

  // mutations -------------------------------------------------------------

  const refreshRecents = useCallback(async () => {
    const r = await api.listRecents();
    setRecents(r?.paths ?? []);
  }, []);

  // Optimistic: the folder leaves the list at once; the refetch restores it if
  // the daemon refused.
  const removeRecent = useCallback(async (path) => {
    setRecents((prev) => prev.filter((p) => p !== path));
    const r = await api.removeRecent(path).catch(() => null);
    if (!r?.ok) notify.error("Couldn't remove the folder from the list");
    refreshRecents();
  }, [refreshRecents]);

  const spawnOrchestrator = useCallback(async ({ name, cwd, scratch, model, effort, prompt, permissionMode, backendKind, backendProfile, mode } = {}) => {
    const r = await api.spawnOrchestrator({ name, cwd, scratch, model, effort, prompt, permissionMode, backendKind, backendProfile, mode });
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

  const sendToAgent = useCallback(async (id, text, { clientMsgId, queueWhenBusy, replyTo, action } = {}) => {
    setInterruptedId(null);
    // New turn starting — retire the previous turn's finalized thinking buffers.
    dropInterruptedThinking(id);
    const worker = workersRef.current.find((w) => w.id === id);
    if (!worker) return { ok: false, status: 404, body: { error: "not found" } };
    const opts = { clientMsgId, queueWhenBusy, replyTo, action };
    const r = worker.is_orchestrator
      ? await api.sendOrchestratorMessage(id, text, opts)
      : await api.sendWorkerMessage(id, text, opts);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch, setInterruptedId]);

  const interruptAgent = useCallback(async (id) => {
    setInterruptedId(id, workersRef.current.find((w) => w.id === id)?.turn_started_at);
    // Esc cancels what the user queued — the daemon clears its pending rows
    // before the IDLE transition; mirror that on the pills instantly.
    cancelQueued(id);
    const r = await api.interruptWorker(id);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch, setInterruptedId]);

  // Drop a removed agent's subtree from the snapshot right away instead of
  // waiting for the debounced refetch — otherwise the caller's collapsed-state
  // cleanup lands first and the subtree briefly renders expanded before it
  // vanishes. Taking a fresh seq also discards any older in-flight fetch that
  // would bring the rows back.
  const dropSubtree = useCallback((id) => {
    const doomed = new Set(subtreeIds(workersRef.current, id));
    applyWorkers(++workersSeqRef.current, workersRef.current.filter((w) => !doomed.has(w.id)));
  }, [applyWorkers]);

  // Archive replaces the old hard delete for every UI entry point. The row
  // (and its subtree) leaves the snapshot, so downstream vanish handling
  // (prunePanes, selection cleanup, useStorePrune) is unchanged.
  const archiveAgent = useCallback(async (id) => {
    const r = await api.archiveWorker(id);
    if (r?.ok) dropSubtree(id);
    scheduleRefetch();
    void refreshArchived();
    return r;
  }, [scheduleRefetch, dropSubtree]);

  const restoreAgent = useCallback(async (id) => {
    const r = await api.restoreWorker(id);
    scheduleRefetch();
    void refreshArchived();
    return r;
  }, [scheduleRefetch]);

  const purgeAgent = useCallback(async (id) => {
    const r = await api.purgeWorker(id);
    scheduleRefetch();
    void refreshArchived();
    return r;
  }, [scheduleRefetch]);

  // Permanent delete of a LIVE agent — menu-only and confirm-gated at the call
  // site; Cmd+W stays archive-only.
  const killAgent = useCallback(async (id) => {
    const r = await api.killWorker(id);
    if (r?.ok) dropSubtree(id);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch, dropSubtree]);

  const renameAgent = useCallback(async (id, name) => {
    // Optimistic — avoid flashing the old name between input close and
    // the refetch landing.
    applyWorkers(++workersSeqRef.current, latestWorkersRef.current.map((w) => w.id === id ? { ...w, name } : w));
    const r = await api.renameWorker(id, name || null);
    scheduleRefetch();
    return r;
  }, [scheduleRefetch, applyWorkers]);

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
    removeRecent,
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
