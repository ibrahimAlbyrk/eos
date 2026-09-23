import { useCallback, useContext, useMemo, useRef } from "react";
import { NavigationProvider, useNavigation } from "./navigation.jsx";
import { SelectionProvider, useSelection, EMPTY_PANEL } from "./selection.jsx";
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

  // The pane this subtree renders inside (a transcript click / the side panel) or
  // null for shared chrome → fall back to the focused pane. Scopes the per-pane
  // composer popover AND the per-pane right side panel, so one pane's menu/panel
  // doesn't render in the others; chrome outside a pane resolves to the focused
  // pane. See selection.jsx for the raw pane-explicit ops wrapped below.
  const originPane = useContext(PaneScopeContext);
  const scopePane = originPane ?? pane.focusedLeafId;
  const scopeRef = useRef(scopePane);
  scopeRef.current = scopePane;

  const { openPopoverIn, openPopIn, closePopsIn } = selection;
  // Scope-aware popover open/close: a composer targets its OWN pane, chrome the
  // focused pane. Keeps every call site (ui.openPop(id)/ui.closeAllPops()) intact.
  const openPop = useCallback((id, opts = {}) => openPopIn(scopeRef.current, id, opts), [openPopIn]);
  const closeAllPops = useCallback(() => closePopsIn(scopeRef.current), [closePopsIn]);

  // Scope-aware side-panel: resolve THIS consumer's pane state + wrap the raw
  // pane-explicit ops so every call site (ui.openPanel/ui.setTab/…) targets the
  // owning/focused pane with no prop-drilling.
  const { openPanelIn, setTabIn, closeTabIn, closePanelIn, toggleSidePanelIn, toggleFullscreenIn, setWidthIn, openFileIn, closeFileIn, panelsByPane } = selection;
  const panelState = panelsByPane[scopePane] ?? EMPTY_PANEL;
  const openPanel = useCallback((tab, data) => openPanelIn(scopeRef.current, tab, data), [openPanelIn]);
  const setTab = useCallback((tab) => setTabIn(scopeRef.current, tab), [setTabIn]);
  const closeTab = useCallback((tab) => closeTabIn(scopeRef.current, tab), [closeTabIn]);
  const closePanel = useCallback(() => closePanelIn(scopeRef.current), [closePanelIn]);
  const toggleSidePanel = useCallback(() => toggleSidePanelIn(scopeRef.current), [toggleSidePanelIn]);
  const toggleFullscreen = useCallback(() => toggleFullscreenIn(scopeRef.current), [toggleFullscreenIn]);
  const setSidePanelWidth = useCallback((px) => setWidthIn(scopeRef.current, px), [setWidthIn]);
  const openFile = useCallback((path, reveal) => openFileIn(scopeRef.current, path, reveal), [openFileIn]);
  const closeFile = useCallback(() => closeFileIn(scopeRef.current), [closeFileIn]);

  return useMemo(() => ({
    ...navigation,
    ...selection,
    ...pane,
    ...composer,
    ...attention,
    ...search,
    ...settings,
    // The resolved pane this consumer renders in — for pane-keyed stores and
    // region focus.
    paneId: scopePane,
    // Scope-resolved popover state — overrides the raw paneId-explicit ops
    // spread from selection, so consumers read/act on their own pane's popover.
    openPopover: openPopoverIn(scopePane),
    openPop,
    closeAllPops,
    // Scope-resolved side panel — reads + actions for the owning/focused pane.
    openTabs: panelState.openTabs,
    activeTab: panelState.activeTab,
    showSidePanel: panelState.open,
    sidePanelWidth: panelState.width,
    panelFullscreen: panelState.fullscreen,
    panelData: panelState.data,
    panelFile: panelState.file,
    openPanel, setTab, closeTab, closePanel, toggleSidePanel, toggleFullscreen, setSidePanelWidth, openFile, closeFile,
  }), [
    navigation, selection, pane, composer, attention, search, settings, scopePane,
    openPopoverIn, openPop, closeAllPops,
    panelState, openPanel, setTab, closeTab, closePanel, toggleSidePanel, toggleFullscreen, setSidePanelWidth, openFile, closeFile,
  ]);
}
