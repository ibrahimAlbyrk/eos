import { useCallback, useContext, useMemo, useRef } from "react";
import { NavigationProvider, useNavigation } from "./navigation.jsx";
import { SelectionProvider, useSelection } from "./selection.jsx";
import { PaneProvider, usePane } from "./pane.jsx";
import { PaneScopeContext } from "./paneScope.js";
import { ComposerProvider, useComposer } from "./composer.jsx";
import { AttentionProvider, useAttention } from "./attention.jsx";
import { SearchProvider, useSearch } from "./search.jsx";
import { SettingsProvider, useSettings } from "./settings.jsx";

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

  const { topPanelTypeIn, panelDataIn, openPanelIn, closePanelIn, updatePanelDataIn } = selection;

  // Scope-aware actions. Read scope from a ref so identities stay stable across
  // renders — some viewers list these in useCallback deps.
  const openFileViewer = useCallback((path) => openPanelIn(scopeRef.current, "file", { path }), [openPanelIn]);
  const closeFileViewer = useCallback(() => closePanelIn(scopeRef.current, "file"), [closePanelIn]);
  const openAgentViewer = useCallback((block) => openPanelIn(scopeRef.current, "agent", block), [openPanelIn]);
  const closeAgentViewer = useCallback(() => closePanelIn(scopeRef.current, "agent"), [closePanelIn]);
  const syncAgentViewer = useCallback((block) => updatePanelDataIn(scopeRef.current, "agent", (prev) => prev.toolUseId === block.toolUseId ? block : prev), [updatePanelDataIn]);
  const openDiffViewer = useCallback((workerId) => openPanelIn(scopeRef.current, "diff", { workerId }), [openPanelIn]);
  const closeDiffViewer = useCallback(() => closePanelIn(scopeRef.current, "diff"), [closePanelIn]);
  const openCommitsViewer = useCallback((cwd) => openPanelIn(scopeRef.current, "commits", { cwd }), [openPanelIn]);
  const closeCommitsViewer = useCallback(() => closePanelIn(scopeRef.current, "commits"), [closePanelIn]);
  const openConflictResolver = useCallback((workerId) => openPanelIn(scopeRef.current, "conflict", { workerId }), [openPanelIn]);
  const closeConflictResolver = useCallback(() => closePanelIn(scopeRef.current, "conflict"), [closePanelIn]);
  const openMemoryViewer = useCallback((workerId) => openPanelIn(scopeRef.current, "memory", { workerId }), [openPanelIn]);
  const closeMemoryViewer = useCallback(() => closePanelIn(scopeRef.current, "memory"), [closePanelIn]);

  return useMemo(() => {
    // Per-pane resolved reads (recompute when the panel map or scope changes).
    const panels = {
      topPanelType: topPanelTypeIn(scopePane),
      fileViewer: panelDataIn(scopePane, "file"),
      agentViewer: panelDataIn(scopePane, "agent"),
      diffViewer: panelDataIn(scopePane, "diff"),
      commitsViewer: panelDataIn(scopePane, "commits"),
      conflictViewer: panelDataIn(scopePane, "conflict"),
      memoryViewer: panelDataIn(scopePane, "memory"),
      openFileViewer, closeFileViewer,
      openAgentViewer, closeAgentViewer, syncAgentViewer,
      openDiffViewer, closeDiffViewer,
      openCommitsViewer, closeCommitsViewer,
      openConflictResolver, closeConflictResolver,
      openMemoryViewer, closeMemoryViewer,
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
    };
  }, [
    navigation, selection, pane, composer, attention, search, settings, scopePane,
    topPanelTypeIn, panelDataIn,
    openFileViewer, closeFileViewer, openAgentViewer, closeAgentViewer, syncAgentViewer,
    openDiffViewer, closeDiffViewer, openCommitsViewer, closeCommitsViewer,
    openConflictResolver, closeConflictResolver, openMemoryViewer, closeMemoryViewer,
  ]);
}
