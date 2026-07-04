import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { pushSelection, takePrevious } from "../lib/selectionHistory.js";
import {
  emptyDock, openPanelTile, closePanelTile, updatePanelTileData,
  hasPanelTile, panelTileData, panelTypes, setDockRatio,
} from "../lib/panelTiling.js";
import { getPanel } from "../lib/panelRegistry.js";
import { loadPanelDocks, savePanelDocks } from "../lib/panelPersist.js";
import { loadCollapsedNodes, saveCollapsedNodes } from "../lib/collapseMemory.js";

const SelectionContext = createContext(null);

export function SelectionProvider({ children }) {
  const [selectedId, _setSelectedId] = useState(() => localStorage.getItem("cm:selectedId"));
  // Mirrors selectedId synchronously so setSelectedId can read the id it's
  // leaving without an impure functional updater. History is the most-recent-
  // last stack of prior selections (see lib/selectionHistory.js).
  const selectedIdRef = useRef(selectedId);
  const historyRef = useRef([]);
  const setSelectedId = useCallback((id) => {
    historyRef.current = pushSelection(historyRef.current, selectedIdRef.current, id);
    selectedIdRef.current = id;
    _setSelectedId(id);
    if (id) localStorage.setItem("cm:selectedId", id);
    else localStorage.removeItem("cm:selectedId");
  }, []);
  // Pop the most-recent prior selection that still satisfies `exists`. Agent
  // deletion uses this to re-select the agent shown before the deleted one.
  const takePreviousSelection = useCallback((exists) => {
    const { id, history } = takePrevious(historyRef.current, exists, selectedIdRef.current);
    historyRef.current = history;
    return id;
  }, []);
  const [sideCollapsed, setSideCollapsed] = useState(() => localStorage.getItem("cm:sideCollapsed") === "1");

  useEffect(() => { localStorage.setItem("cm:sideCollapsed", sideCollapsed ? "1" : "0"); }, [sideCollapsed]);
  // Popover open state is PER PANE, keyed by leaf id: { [paneId]: id }. Each
  // pane owns its own Composer, so opening one pane's menu must not render it in
  // the others (they gated on a single global string before). Chrome outside a
  // pane resolves to the focused pane via useUi's scope. Position/data stay
  // global — only the mutually-exclusive chrome context menus use them.
  const [openPopoverByPane, setOpenPopoverByPane] = useState({});
  const openPopByPaneRef = useRef(openPopoverByPane);
  openPopByPaneRef.current = openPopoverByPane;
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [popoverData, setPopoverData] = useState({});
  const [collapsedNodes, setCollapsedNodes] = useState(() => loadCollapsedNodes());
  useEffect(() => { saveCollapsedNodes(collapsedNodes); }, [collapsedNodes]);
  const [expandedTools, setExpandedTools] = useState(() => new Set());
  // Right-panel docks, keyed by paneId: { [leafId]: dock } where a dock is the
  // { slots, nextSeq, ratios } object lib/panelTiling manages. Each pane owns its
  // own dock (see PanelDock); the tiling engine lays its ≤3 open panels out. The
  // pane-aware reads/wrappers live in useUi (it resolves the pane via
  // PaneScopeContext); this provider owns the map + the raw paneId-explicit ops.
  // Slot structure + ratios persist across reloads (cm:panelDocks); terminal is
  // session-only and stripped on save.
  const [docksByPane, setDocksByPane] = useState(loadPanelDocks);
  const docksRef = useRef(docksByPane);
  docksRef.current = docksByPane;
  useEffect(() => { savePanelDocks(docksByPane); }, [docksByPane]);
  const dockOf = (paneId) => docksRef.current[paneId] ?? emptyDock();
  // topPanelType compat: the most-recently-opened type (max seq), or null. Used by
  // shared chrome that only needs "is a panel open / which is active" (monitor,
  // Escape-pops-a-panel), NOT for per-panel visibility (the dock shows all open).
  const topPanelTypeIn = useCallback((paneId) => {
    if (paneId == null) return null;
    const { slots } = dockOf(paneId);
    if (!slots.length) return null;
    let m = slots[0];
    for (const s of slots) if (s.seq > m.seq) m = s;
    return m.type;
  }, []);
  const openPanelTypesIn = useCallback((paneId) => (paneId == null ? [] : panelTypes(dockOf(paneId))), []);
  const hasPanelIn = useCallback((paneId, type) => paneId != null && hasPanelTile(dockOf(paneId), type), []);
  const hasAnyPanelIn = useCallback((paneId) => paneId != null && dockOf(paneId).slots.length > 0, []);
  const panelDataIn = useCallback((paneId, type) => (paneId == null ? null : panelTileData(dockOf(paneId), type)), []);
  const dockRatiosIn = useCallback((paneId) => (paneId == null ? emptyDock().ratios : dockOf(paneId).ratios), []);
  const openPanelIn = useCallback((paneId, type, data) => {
    if (paneId == null) return;
    setDocksByPane((m) => {
      const { dock, evicted } = openPanelTile(m[paneId] ?? emptyDock(), type, data);
      if (evicted) getPanel(evicted)?.dispose?.(); // e.g. terminal → kill sessions
      return { ...m, [paneId]: dock };
    });
  }, []);
  const closePanelIn = useCallback((paneId, type) => {
    if (paneId == null) return;
    setDocksByPane((m) => {
      const dock = m[paneId];
      if (!dock) return m;
      const { dock: next, closed } = closePanelTile(dock, type);
      return closed ? { ...m, [paneId]: next } : m;
    });
  }, []);
  // Escape closes the most-recently-opened panel in the focused pane's dock.
  const popPanelIn = useCallback((paneId) => {
    const type = topPanelTypeIn(paneId);
    if (type) closePanelIn(paneId, type);
  }, [topPanelTypeIn, closePanelIn]);
  const updatePanelDataIn = useCallback((paneId, type, updater) => {
    if (paneId == null) return;
    setDocksByPane((m) => {
      const dock = m[paneId];
      if (!dock) return m;
      const next = updatePanelTileData(dock, type, updater);
      return next === dock ? m : { ...m, [paneId]: next };
    });
  }, []);
  const setDockRatioIn = useCallback((paneId, key, value) => {
    if (paneId == null) return;
    setDocksByPane((m) => {
      const dock = m[paneId] ?? emptyDock();
      const next = setDockRatio(dock, key, value);
      return next === dock ? m : { ...m, [paneId]: next };
    });
  }, []);
  // Clear-on-rebuild hooks, driven by PaneProvider (which owns the tree).
  const clearPanelsIn = useCallback((paneId) => setDocksByPane((m) => {
    if (!(paneId in m)) return m;
    const next = { ...m };
    delete next[paneId];
    return next;
  }), []);
  const retainPanelsFor = useCallback((liveIds) => setDocksByPane((m) => {
    const keys = Object.keys(m);
    if (keys.every((k) => liveIds.has(k))) return m;
    const next = {};
    for (const k of keys) if (liveIds.has(k)) next[k] = m[k];
    return next;
  }), []);
  // Escape pops the FOCUSED pane's stack. The keydown lives here but this
  // provider can't see pane focus, so PaneProvider registers a focus-aware
  // popper (mirrors registerEscapeGitMode). Returns true when it consumed Esc.
  const escapePanelRef = useRef(null);
  const registerEscapePanel = useCallback((fn) => { escapePanelRef.current = fn; }, []);
  const [renamingId, setRenamingId] = useState(null);
  const [pendingQuestion, setPendingQuestion] = useState(null);
  // {workerId, verdict, command, ts} — derived by Messages from the loaded
  // event window (same publish pattern as pendingQuestion); read by the
  // diff row / diff viewer verdict chips. Advisory only.
  const [verdict, setVerdict] = useState(null);
  const [dismissedQuestions, setDismissedQuestions] = useState(() => new Set());
  const dismissQuestion = useCallback((toolUseId) => {
    setDismissedQuestions((prev) => new Set(prev).add(toolUseId));
  }, []);
  // {workerId} while the rewind panel is open (double-Esc, like Claude Code).
  const [rewindPanel, setRewindPanel] = useState(null);
  const openRewindPanel = useCallback((workerId) => setRewindPanel({ workerId }), []);
  const closeRewindPanel = useCallback(() => setRewindPanel(null), []);
  const lastEscTsRef = useRef(0);
  const escapeIdleRef = useRef(null);
  const registerEscapeIdle = useCallback((fn) => { escapeIdleRef.current = fn; }, []);
  // Composer registers a handler that exits git mode; returns true when it
  // consumed the Escape (ComposerProvider lives below this provider, so the
  // state itself isn't readable here).
  const escapeGitModeRef = useRef(null);
  const registerEscapeGitMode = useCallback((fn) => { escapeGitModeRef.current = fn; }, []);

  // Raw paneId-explicit popover ops. useUi wraps these into the scope-aware
  // openPop/closeAllPops/openPopover that every call site uses (mirrors the
  // panelsByPane pattern) — a composer scopes to its own pane, chrome to focused.
  const openPopoverIn = useCallback((paneId) => openPopByPaneRef.current[paneId] ?? null, []);
  const openPopIn = useCallback((paneId, id, opts = {}) => {
    setOpenPopoverByPane((m) => ({ ...m, [paneId]: id }));
    if (opts.x != null && opts.y != null) setPopoverPos({ x: opts.x, y: opts.y });
    if (opts.data) setPopoverData(opts.data);
  }, []);
  const closePopsIn = useCallback((paneId) => {
    setOpenPopoverByPane((m) => {
      if (!(paneId in m)) return m;
      const next = { ...m };
      delete next[paneId];
      return next;
    });
    setPopoverData({});
  }, []);
  // Close every pane's popover at once — Escape and any global dismissal.
  const closeAllPopsEverywhere = useCallback(() => {
    setOpenPopoverByPane((m) => (Object.keys(m).length ? {} : m));
    setPopoverData({});
  }, []);

  // (Clear-on-select is now per pane: PaneProvider clears a pane's stack when
  // that pane's shown agent changes — see pane.jsx — preserving single-pane
  // parity without nuking another pane's panel on a focus move.)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // consumed inside the editor (e.g. closing the autocomplete popup)
      if (e.defaultPrevented) return;
      // preventDefault on every handled Escape: an unconsumed Esc reaches the
      // WKWebView's native responder chain → NSWindow cancelOperation: → exits
      // macOS fullscreen. Closing a panel must not also drop fullscreen.
      if (rewindPanel) { e.preventDefault(); setRewindPanel(null); return; }
      if (Object.keys(openPopByPaneRef.current).length) { e.preventDefault(); closeAllPopsEverywhere(); return; }
      if (escapePanelRef.current?.()) { e.preventDefault(); return; }
      if (escapeGitModeRef.current?.()) { e.preventDefault(); return; }
      // Double-Esc with an agent selected → rewind panel (Claude Code parity:
      // composer's own double-Esc-clears-text path preventDefaults, so this
      // only fires when the input was already empty).
      const now = Date.now();
      const isDouble = now - lastEscTsRef.current <= 500;
      lastEscTsRef.current = now;
      if (isDouble && selectedId) {
        e.preventDefault();
        setRewindPanel({ workerId: selectedId });
        return;
      }
      if (escapeIdleRef.current) { e.preventDefault(); escapeIdleRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeAllPopsEverywhere, rewindPanel, selectedId]);

  const toggleNodeCollapsed = useCallback((id) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const removeCollapsedNodes = useCallback((ids) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) if (next.delete(id)) changed = true;
      return changed ? next : prev;
    });
  }, []);

  const toggleToolExpanded = useCallback((id) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Toggles are XOR overrides against the settings-driven default (see
  // settings/toolExpansion.js). When a verbose.* setting changes, stale
  // toggles would invert the new default — so settings.jsx drops them all.
  const resetToolToggles = useCallback(() => setExpandedTools(new Set()), []);

  const value = useMemo(() => ({
    selectedId, setSelectedId, takePreviousSelection,
    sideCollapsed, setSideCollapsed,
    openPopoverIn, openPopIn, closePopsIn, closeAllPopsEverywhere, popoverPos, popoverData,
    collapsedNodes, toggleNodeCollapsed, removeCollapsedNodes,
    expandedTools, toggleToolExpanded, resetToolToggles,
    renamingId, setRenamingId,
    pendingQuestion, setPendingQuestion, dismissedQuestions, dismissQuestion,
    verdict, setVerdict,
    // Raw paneId-explicit panel ops + reads. useUi wraps these into the
    // scope-aware openFileViewer/isPanelOpen/... that every consumer calls.
    topPanelTypeIn, panelDataIn, openPanelTypesIn, hasPanelIn, hasAnyPanelIn, dockRatiosIn,
    openPanelIn, closePanelIn, popPanelIn, updatePanelDataIn, setDockRatioIn,
    clearPanelsIn, retainPanelsFor, registerEscapePanel,
    rewindPanel, openRewindPanel, closeRewindPanel,
    registerEscapeIdle,
    registerEscapeGitMode,
  }), [
    selectedId, setSelectedId, takePreviousSelection,
    sideCollapsed, openPopoverByPane, popoverPos, popoverData,
    collapsedNodes, expandedTools, renamingId, pendingQuestion, dismissedQuestions, verdict, docksByPane,
    rewindPanel, openRewindPanel, closeRewindPanel,
    openPopoverIn, openPopIn, closePopsIn, closeAllPopsEverywhere, toggleNodeCollapsed, removeCollapsedNodes, toggleToolExpanded, resetToolToggles,
    topPanelTypeIn, panelDataIn, openPanelTypesIn, hasPanelIn, hasAnyPanelIn, dockRatiosIn,
    openPanelIn, closePanelIn, popPanelIn, updatePanelDataIn, setDockRatioIn,
    clearPanelsIn, retainPanelsFor, registerEscapePanel,
    registerEscapeIdle,
    registerEscapeGitMode,
  ]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection() {
  const c = useContext(SelectionContext);
  if (!c) throw new Error("useSelection outside SelectionProvider");
  return c;
}
