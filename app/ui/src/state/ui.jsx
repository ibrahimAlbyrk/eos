import { useCallback, useContext, useMemo, useRef } from "react";
import { NavigationProvider, useNavigation } from "./navigation.jsx";
import { SelectionProvider, useSelection } from "./selection.jsx";
import { PaneProvider, usePane } from "./pane.jsx";
import { PaneScopeContext } from "./paneScope.js";
import { ComposerProvider, useComposer } from "./composer.jsx";
import { AttentionProvider, useAttention } from "./attention.jsx";
import { SearchProvider, useSearch } from "./search.jsx";
import { SettingsProvider, useSettings } from "./settings.jsx";
import { canFitColumns } from "../lib/panelTiling.js";
import { panelMinSize } from "../lib/panelRegistry.js";
import { getDockWidth } from "./dockMetrics.js";
import { notify } from "../lib/notify.js";

// Monotonic reveal token: a scroll-to-line target carries a seq so re-navigating
// to the same file+line still re-centers the editor (see EditView revealSeq).
let revealSeq = 0;

export { useNavigation } from "./navigation.jsx";
export { useSelection } from "./selection.jsx";
export { usePane } from "./pane.jsx";
export { useComposer } from "./composer.jsx";
export { useAttention, useAttentionSync } from "./attention.jsx";
export { useSearch } from "./search.jsx";
export { useSettings } from "./settings.jsx";

export function UiProvider({ children }) {
  return (
    <NavigationProvider>
      <SelectionProvider>
        <PaneProvider>
          <ComposerProvider>
            <SettingsProvider>
              <AttentionProvider>
                <SearchProvider>
                  {children}
                </SearchProvider>
              </AttentionProvider>
            </SettingsProvider>
          </ComposerProvider>
        </PaneProvider>
      </SelectionProvider>
    </NavigationProvider>
  );
}

export function useUi() {
  const navigation = useNavigation();
  const selection = useSelection();
  const pane = usePane();
  const composer = useComposer();
  const attention = useAttention();
  const search = useSearch();
  const settings = useSettings();

  // The pane this subtree renders inside (transcript click / docked viewer) or
  // null for shared chrome → fall back to the focused pane. This single line is
  // what makes ui.openFileViewer(...) / ui.topPanelType target the right pane
  // with ZERO call-site changes: a viewer reads its own pane, the composer the
  // focused one.
  const originPane = useContext(PaneScopeContext);
  const scopePane = originPane ?? pane.focusedLeafId;
  const scopeRef = useRef(scopePane);
  scopeRef.current = scopePane;

  const { topPanelTypeIn, panelDataIn, openPanelTypesIn, hasPanelIn, hasAnyPanelIn, dockRatiosIn } = selection;
  const { openPanelIn, closePanelIn, updatePanelDataIn, setDockRatioIn } = selection;
  const { openPopoverIn, openPopIn, closePopsIn } = selection;

  // Open into the scoped pane's dock, with the settled degenerate guard: a NEW
  // distinct type that would become the 3rd panel needs two side-by-side columns
  // (left = the existing stacked pair, right = the newcomer). Refuse + notify when
  // the dock can't fit both at their min widths (like splitLeaf at MAX_PANES). A
  // reuse (same type) or a 4th-that-evicts never adds a column, so it's unguarded.
  const openScoped = useCallback((type, data) => {
    const paneId = scopeRef.current;
    const types = openPanelTypesIn(paneId);
    if (!types.includes(type) && types.length === 2) {
      const w = getDockWidth(paneId);
      const leftMin = Math.max(panelMinSize(types[0]).minW, panelMinSize(types[1]).minW);
      const rightMin = panelMinSize(type).minW;
      if (w > 0 && !canFitColumns(w, leftMin, rightMin)) {
        notify.warning("Not enough room for a third panel — close one first.");
        return;
      }
    }
    openPanelIn(paneId, type, data);
  }, [openPanelTypesIn, openPanelIn]);

  // Scope-aware popover open/close: a composer targets its OWN pane, chrome the
  // focused pane. Keeps every call site (ui.openPop(id)/ui.closeAllPops()) intact
  // while making the open state per pane — one pane's menu no longer opens in all.
  const openPop = useCallback((id, opts = {}) => openPopIn(scopeRef.current, id, opts), [openPopIn]);
  const closeAllPops = useCallback(() => closePopsIn(scopeRef.current), [closePopsIn]);

  // Scope-aware actions. Read scope from a ref so identities stay stable across
  // renders — some viewers list these in useCallback deps.
  // reveal (optional) = { line, column } → scroll the editor to that spot on open.
  // A fresh seq each call re-fires the editor's reveal even for the same target.
  const openFileViewer = useCallback((path, reveal) => openScoped("file", reveal
    ? { path, reveal: { line: reveal.line, column: reveal.column, seq: ++revealSeq } }
    : { path }), [openScoped]);
  const closeFileViewer = useCallback(() => closePanelIn(scopeRef.current, "file"), [closePanelIn]);
  const openAgentViewer = useCallback((block) => openScoped("agent", block), [openScoped]);
  const closeAgentViewer = useCallback(() => closePanelIn(scopeRef.current, "agent"), [closePanelIn]);
  const syncAgentViewer = useCallback((block) => updatePanelDataIn(scopeRef.current, "agent", (prev) => prev.toolUseId === block.toolUseId ? block : prev), [updatePanelDataIn]);
  const openDiffViewer = useCallback((workerId) => openScoped("diff", { workerId }), [openScoped]);
  const closeDiffViewer = useCallback(() => closePanelIn(scopeRef.current, "diff"), [closePanelIn]);
  const openCommitsViewer = useCallback((cwd) => openScoped("commits", { cwd }), [openScoped]);
  const closeCommitsViewer = useCallback(() => closePanelIn(scopeRef.current, "commits"), [closePanelIn]);
  // workerId is optional — carried alongside cwd so the folded conflicts section
  // can reach the worker-scoped resolve endpoints; absent when opened on a bare
  // dir (a new-session pane), where the conflicts section stays hidden.
  const openGitDiffViewer = useCallback((cwd, workerId) => openScoped("gitdiff", { cwd, workerId }), [openScoped]);
  const closeGitDiffViewer = useCallback(() => closePanelIn(scopeRef.current, "gitdiff"), [closePanelIn]);
  const openTerminalViewer = useCallback(() => openScoped("terminal", {}), [openScoped]);
  const closeTerminalViewer = useCallback(() => closePanelIn(scopeRef.current, "terminal"), [closePanelIn]);
  const setDockRatio = useCallback((key, value) => setDockRatioIn(scopeRef.current, key, value), [setDockRatioIn]);

  return useMemo(() => {
    // Per-pane resolved reads (recompute when the dock map or scope changes).
    const panels = {
      // The resolved pane this consumer renders in — for pane-keyed stores
      // (ptyPanelStore) and registry close handlers.
      paneId: scopePane,
      topPanelType: topPanelTypeIn(scopePane),
      openPanelTypes: openPanelTypesIn(scopePane),
      isPanelOpen: (type) => hasPanelIn(scopePane, type),
      hasAnyPanelIn,
      dockRatios: dockRatiosIn(scopePane),
      setDockRatio,
      fileViewer: panelDataIn(scopePane, "file"),
      agentViewer: panelDataIn(scopePane, "agent"),
      diffViewer: panelDataIn(scopePane, "diff"),
      commitsViewer: panelDataIn(scopePane, "commits"),
      gitDiffViewer: panelDataIn(scopePane, "gitdiff"),
      terminalViewer: panelDataIn(scopePane, "terminal"),
      openFileViewer, closeFileViewer,
      openAgentViewer, closeAgentViewer, syncAgentViewer,
      openDiffViewer, closeDiffViewer,
      openCommitsViewer, closeCommitsViewer,
      openGitDiffViewer, closeGitDiffViewer,
      openTerminalViewer, closeTerminalViewer,
    };
    return {
      ...navigation,
      ...selection,
      ...pane,
      ...composer,
      ...attention,
      ...search,
      ...settings,
      ...panels,
      // Scope-resolved popover state — overrides the raw paneId-explicit ops
      // spread from selection, so consumers read/act on their own pane's popover.
      openPopover: openPopoverIn(scopePane),
      openPop,
      closeAllPops,
    };
  }, [
    navigation, selection, pane, composer, attention, search, settings, scopePane,
    topPanelTypeIn, panelDataIn, openPanelTypesIn, hasPanelIn, hasAnyPanelIn, dockRatiosIn, setDockRatio,
    openPopoverIn, openPop, closeAllPops,
    openFileViewer, closeFileViewer, openAgentViewer, closeAgentViewer, syncAgentViewer,
    openDiffViewer, closeDiffViewer, openCommitsViewer, closeCommitsViewer,
    openGitDiffViewer, closeGitDiffViewer,
    openTerminalViewer, closeTerminalViewer,
  ]);
}
