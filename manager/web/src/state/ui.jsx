// UiContext — global UI state shared across panels. Holds the selected
// agent id, sidebar/islands visibility, which popover is open, and the
// composer settings (folder/branch/worktree/model/effort/permissionMode)
// before the first message of a session has been sent.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

const UiContext = createContext(null);

const DEFAULT_COMPOSER = {
  cwd: null,
  branch: null,
  worktree: false,
  model: "opus",
  effort: "high",
  permissionMode: "acceptEdits",
};

export function UiProvider({ children }) {
  const [selectedId, setSelectedId] = useState(null);
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [islandsHidden, setIslandsHidden] = useState(false);
  const [openPopover, setOpenPopover] = useState(null);
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [popoverData, setPopoverData] = useState({});
  const [collapsedNodes, setCollapsedNodes] = useState(() => new Set());
  const [composer, setComposer] = useState(DEFAULT_COMPOSER);
  // Optimistic user messages per worker — added synchronously on send so the
  // bubble appears immediately. Removed when the server-side `user_message`
  // event comes back via the next /events poll.
  // Shape: Map<workerId, Array<{ id: string, text: string, ts: number }>>
  const [optimisticMsgs, setOptimisticMsgs] = useState(() => new Map());
  // Draft orchestrators — created locally by the user via the sidebar "+"
  // button. Each holds its own composer settings until the first message is
  // sent, at which point spawnOrchestrator is called with these settings and
  // the draft is swapped for a real worker row.
  // Shape: Map<draftId, { name, cwd, branch, worktree, model, effort, permissionMode, createdAt }>
  const [drafts, setDrafts] = useState(() => new Map());
  // Per-agent "last viewed" activity signature. The sidebar shows a
  // notification dot on rows where the current signature differs from this
  // snapshot. The signature combines state + cumulative tokens + tool calls
  // + cost so any meaningful progress on an unselected agent surfaces.
  const [viewedSignatures, setViewedSignatures] = useState(() => new Map());
  // File viewer panel — null means closed.
  // { path: string, editMode: boolean }
  const [fileViewer, setFileViewer] = useState(null);

  const openPop = useCallback((id, opts = {}) => {
    setOpenPopover(id);
    if (opts.x != null && opts.y != null) setPopoverPos({ x: opts.x, y: opts.y });
    if (opts.data) setPopoverData(opts.data);
  }, []);
  const closeAllPops = useCallback(() => {
    setOpenPopover(null);
    setPopoverData({});
  }, []);

  useEffect(() => { setFileViewer(null); }, [selectedId]);

  // Esc closes everything
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { closeAllPops(); setFileViewer(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeAllPops]);

  const toggleNodeCollapsed = useCallback((id) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const updateComposer = useCallback((patch) => {
    setComposer((c) => ({ ...c, ...patch }));
  }, []);

  const addOptimisticUserMessage = useCallback((workerId, text) => {
    if (!workerId || !text) return null;
    const id = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = { id, text, ts: Date.now() };
    setOptimisticMsgs((prev) => {
      const next = new Map(prev);
      const list = next.get(workerId) ? [...next.get(workerId)] : [];
      list.push(entry);
      next.set(workerId, list);
      return next;
    });
    return id;
  }, []);

  // ---- Drafts -----------------------------------------------------------

  const createDraft = useCallback((name) => {
    const id = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setDrafts((prev) => {
      const next = new Map(prev);
      // Seed from current global composer so a half-edited config row carries
      // over into the new draft, matching the user's mental model.
      next.set(id, {
        name: name || "",
        cwd: null,
        branch: null,
        worktree: false,
        model: DEFAULT_COMPOSER.model,
        effort: DEFAULT_COMPOSER.effort,
        permissionMode: DEFAULT_COMPOSER.permissionMode,
        createdAt: Date.now(),
      });
      return next;
    });
    setSelectedId(id);
    return id;
  }, []);

  const updateDraft = useCallback((id, patch) => {
    setDrafts((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, { ...prev.get(id), ...patch });
      return next;
    });
  }, []);

  // ---- Notifications ----------------------------------------------------

  // Signature deliberately excludes `state` — that transitions to WORKING
  // when the user sends a message, which would (incorrectly) fire a notify
  // dot on an unselected agent the user themselves just messaged. Only
  // agent-produced deltas (tokens, tool calls, cost) count as new activity.
  const sigOf = (w) => `${(w.tokens_in ?? 0) + (w.tokens_out ?? 0)}|${w.tool_calls ?? 0}|${w.cost_usd ?? 0}`;

  // Snapshot a worker's current signature as "seen". Called whenever the
  // user is actively viewing the worker (selection change + every refresh
  // while selected) so the badge stays cleared.
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

  // Seed an agent's "viewed" signature on first appearance so a brand-new
  // worker doesn't immediately trigger a notification.
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

  const openFileViewer = useCallback((path) => {
    setFileViewer({ path, editMode: false });
  }, []);
  const closeFileViewer = useCallback(() => setFileViewer(null), []);
  const toggleFileEditMode = useCallback(() => {
    setFileViewer((prev) => prev ? { ...prev, editMode: !prev.editMode } : null);
  }, []);

  const removeDraft = useCallback((id) => {
    setDrafts((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const reconcileOptimisticMessages = useCallback((workerId, serverTexts) => {
    if (!workerId) return;
    setOptimisticMsgs((prev) => {
      if (!prev.has(workerId)) return prev;
      const list = prev.get(workerId);
      const filtered = list.filter((m) => !serverTexts.has(m.text));
      if (filtered.length === list.length) return prev;
      const next = new Map(prev);
      if (filtered.length === 0) next.delete(workerId);
      else next.set(workerId, filtered);
      return next;
    });
  }, []);

  const value = useMemo(() => ({
    selectedId, setSelectedId,
    sideCollapsed, setSideCollapsed,
    islandsHidden, setIslandsHidden,
    openPopover, openPop, closeAllPops, popoverPos, popoverData,
    collapsedNodes, toggleNodeCollapsed,
    composer, updateComposer,
    optimisticMsgs, addOptimisticUserMessage, reconcileOptimisticMessages,
    drafts, createDraft, updateDraft, removeDraft,
    markViewed, seedViewed, hasNewActivity,
    fileViewer, openFileViewer, closeFileViewer, toggleFileEditMode,
  }), [
    selectedId, sideCollapsed, islandsHidden, openPopover, popoverPos, popoverData,
    collapsedNodes, composer, optimisticMsgs, drafts, fileViewer,
    openPop, closeAllPops, toggleNodeCollapsed, updateComposer,
    addOptimisticUserMessage, reconcileOptimisticMessages,
    createDraft, updateDraft, removeDraft,
    markViewed, seedViewed, hasNewActivity,
    openFileViewer, closeFileViewer, toggleFileEditMode,
  ]);

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi() {
  const c = useContext(UiContext);
  if (!c) throw new Error("useUi outside UiProvider");
  return c;
}
