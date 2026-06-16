import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { pushSelection, takePrevious } from "../lib/selectionHistory.js";
import { openPanel, closePanel, popPanel, topPanel, updatePanelData } from "../lib/panelStack.js";
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
  const [openPopover, setOpenPopover] = useState(null);
  const [popoverPos, setPopoverPos] = useState({ x: 0, y: 0 });
  const [popoverData, setPopoverData] = useState({});
  const [collapsedNodes, setCollapsedNodes] = useState(() => loadCollapsedNodes());
  useEffect(() => { saveCollapsedNodes(collapsedNodes); }, [collapsedNodes]);
  const [expandedTools, setExpandedTools] = useState(() => new Set());
  // Right-panel navigation stack (see lib/panelStack.js). The four viewer
  // fields derive from anywhere in the stack so buried panels stay MOUNTED —
  // their fetched data and expand state survive a viewer pushed on top.
  // topPanelType is the visibility signal: only that island is shown.
  const [panelStack, setPanelStack] = useState([]);
  const topPanelType = topPanel(panelStack)?.type ?? null;
  const panelData = (type) => panelStack.find((p) => p.type === type)?.data ?? null;
  const fileViewer = panelData("file");
  const agentViewer = panelData("agent");
  const diffViewer = panelData("diff");
  // {cwd} — right panel listing committed-but-unpushed commits (@{u}..HEAD).
  const commitsViewer = panelData("commits");
  // {workerId} — right panel resolving the worktree's merge conflicts.
  const conflictViewer = panelData("conflict");
  // {workerId} — right panel browsing the project's Claude file-based memory.
  const memoryViewer = panelData("memory");
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

  const openPop = useCallback((id, opts = {}) => {
    setOpenPopover(id);
    if (opts.x != null && opts.y != null) setPopoverPos({ x: opts.x, y: opts.y });
    if (opts.data) setPopoverData(opts.data);
  }, []);
  const closeAllPops = useCallback(() => {
    setOpenPopover(null);
    setPopoverData({});
  }, []);

  useEffect(() => { setPanelStack([]); }, [selectedId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      // consumed inside the editor (e.g. closing the autocomplete popup)
      if (e.defaultPrevented) return;
      // preventDefault on every handled Escape: an unconsumed Esc reaches the
      // WKWebView's native responder chain → NSWindow cancelOperation: → exits
      // macOS fullscreen. Closing a panel must not also drop fullscreen.
      if (rewindPanel) { e.preventDefault(); setRewindPanel(null); return; }
      if (openPopover) { e.preventDefault(); closeAllPops(); return; }
      if (panelStack.length) { e.preventDefault(); setPanelStack((s) => popPanel(s)); return; }
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
  }, [closeAllPops, openPopover, panelStack, rewindPanel, selectedId]);

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

  const openFileViewer = useCallback((path) => setPanelStack((s) => openPanel(s, "file", { path })), []);
  const closeFileViewer = useCallback(() => setPanelStack((s) => closePanel(s, "file")), []);
  const openAgentViewer = useCallback((block) => setPanelStack((s) => openPanel(s, "agent", block)), []);
  const closeAgentViewer = useCallback(() => setPanelStack((s) => closePanel(s, "agent")), []);
  const openDiffViewer = useCallback((workerId) => setPanelStack((s) => openPanel(s, "diff", { workerId })), []);
  const closeDiffViewer = useCallback(() => setPanelStack((s) => closePanel(s, "diff")), []);
  const openCommitsViewer = useCallback((cwd) => setPanelStack((s) => openPanel(s, "commits", { cwd })), []);
  const closeCommitsViewer = useCallback(() => setPanelStack((s) => closePanel(s, "commits")), []);
  const openConflictResolver = useCallback((workerId) => setPanelStack((s) => openPanel(s, "conflict", { workerId })), []);
  const closeConflictResolver = useCallback(() => setPanelStack((s) => closePanel(s, "conflict")), []);
  const openMemoryViewer = useCallback((workerId) => setPanelStack((s) => openPanel(s, "memory", { workerId })), []);
  const closeMemoryViewer = useCallback(() => setPanelStack((s) => closePanel(s, "memory")), []);
  const syncAgentViewer = useCallback((block) => {
    setPanelStack((s) => updatePanelData(s, "agent", (prev) => prev.toolUseId === block.toolUseId ? block : prev));
  }, []);

  const value = useMemo(() => ({
    selectedId, setSelectedId, takePreviousSelection,
    sideCollapsed, setSideCollapsed,
    openPopover, openPop, closeAllPops, popoverPos, popoverData,
    collapsedNodes, toggleNodeCollapsed, removeCollapsedNodes,
    expandedTools, toggleToolExpanded, resetToolToggles,
    renamingId, setRenamingId,
    pendingQuestion, setPendingQuestion, dismissedQuestions, dismissQuestion,
    verdict, setVerdict,
    topPanelType,
    fileViewer, openFileViewer, closeFileViewer,
    agentViewer, openAgentViewer, closeAgentViewer, syncAgentViewer,
    diffViewer, openDiffViewer, closeDiffViewer,
    commitsViewer, openCommitsViewer, closeCommitsViewer,
    conflictViewer, openConflictResolver, closeConflictResolver,
    memoryViewer, openMemoryViewer, closeMemoryViewer,
    rewindPanel, openRewindPanel, closeRewindPanel,
    registerEscapeIdle,
    registerEscapeGitMode,
  }), [
    selectedId, setSelectedId, takePreviousSelection,
    sideCollapsed, openPopover, popoverPos, popoverData,
    collapsedNodes, expandedTools, renamingId, pendingQuestion, dismissedQuestions, verdict, panelStack,
    rewindPanel, openRewindPanel, closeRewindPanel,
    openPop, closeAllPops, toggleNodeCollapsed, removeCollapsedNodes, toggleToolExpanded, resetToolToggles,
    openFileViewer, closeFileViewer,
    openAgentViewer, closeAgentViewer, syncAgentViewer,
    openDiffViewer, closeDiffViewer,
    openCommitsViewer, closeCommitsViewer,
    openConflictResolver, closeConflictResolver,
    openMemoryViewer, closeMemoryViewer,
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
