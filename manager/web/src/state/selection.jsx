import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { pushSelection, takePrevious } from "../lib/selectionHistory.js";

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
  const [collapsedNodes, setCollapsedNodes] = useState(() => new Set());
  const [expandedTools, setExpandedTools] = useState(() => new Set());
  const [fileViewer, setFileViewer] = useState(null);
  const [agentViewer, setAgentViewer] = useState(null);
  const [diffViewer, setDiffViewer] = useState(null);
  // {cwd} — right panel listing committed-but-unpushed commits (@{u}..HEAD).
  const [commitsViewer, setCommitsViewer] = useState(null);
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

  useEffect(() => { setFileViewer(null); setAgentViewer(null); setDiffViewer(null); setCommitsViewer(null); }, [selectedId]);

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
      if (agentViewer) { e.preventDefault(); setAgentViewer(null); return; }
      if (fileViewer) { e.preventDefault(); setFileViewer(null); return; }
      if (diffViewer) { e.preventDefault(); setDiffViewer(null); return; }
      if (commitsViewer) { e.preventDefault(); setCommitsViewer(null); return; }
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
  }, [closeAllPops, openPopover, fileViewer, agentViewer, diffViewer, commitsViewer, rewindPanel, selectedId]);

  const toggleNodeCollapsed = useCallback((id) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleToolExpanded = useCallback((id) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const openFileViewer = useCallback((path) => {
    setAgentViewer(null);
    setDiffViewer(null);
    setCommitsViewer(null);
    setFileViewer({ path });
  }, []);
  const closeFileViewer = useCallback(() => setFileViewer(null), []);
  const openAgentViewer = useCallback((block) => {
    setFileViewer(null);
    setDiffViewer(null);
    setCommitsViewer(null);
    setAgentViewer(block);
  }, []);
  const closeAgentViewer = useCallback(() => setAgentViewer(null), []);
  const openDiffViewer = useCallback((workerId) => {
    setFileViewer(null);
    setAgentViewer(null);
    setCommitsViewer(null);
    setDiffViewer({ workerId });
  }, []);
  const closeDiffViewer = useCallback(() => setDiffViewer(null), []);
  const openCommitsViewer = useCallback((cwd) => {
    setFileViewer(null);
    setAgentViewer(null);
    setDiffViewer(null);
    setCommitsViewer({ cwd });
  }, []);
  const closeCommitsViewer = useCallback(() => setCommitsViewer(null), []);
  const syncAgentViewer = useCallback((block) => {
    setAgentViewer((prev) => prev && prev.toolUseId === block.toolUseId ? block : prev);
  }, []);

  const value = useMemo(() => ({
    selectedId, setSelectedId, takePreviousSelection,
    sideCollapsed, setSideCollapsed,
    openPopover, openPop, closeAllPops, popoverPos, popoverData,
    collapsedNodes, toggleNodeCollapsed,
    expandedTools, toggleToolExpanded,
    renamingId, setRenamingId,
    pendingQuestion, setPendingQuestion, dismissedQuestions, dismissQuestion,
    verdict, setVerdict,
    fileViewer, openFileViewer, closeFileViewer,
    agentViewer, openAgentViewer, closeAgentViewer, syncAgentViewer,
    diffViewer, openDiffViewer, closeDiffViewer,
    commitsViewer, openCommitsViewer, closeCommitsViewer,
    rewindPanel, openRewindPanel, closeRewindPanel,
    registerEscapeIdle,
    registerEscapeGitMode,
  }), [
    selectedId, setSelectedId, takePreviousSelection,
    sideCollapsed, openPopover, popoverPos, popoverData,
    collapsedNodes, expandedTools, renamingId, pendingQuestion, dismissedQuestions, verdict, fileViewer, agentViewer, diffViewer, commitsViewer,
    rewindPanel, openRewindPanel, closeRewindPanel,
    openPop, closeAllPops, toggleNodeCollapsed, toggleToolExpanded,
    openFileViewer, closeFileViewer,
    openAgentViewer, closeAgentViewer, syncAgentViewer,
    openDiffViewer, closeDiffViewer,
    openCommitsViewer, closeCommitsViewer,
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
