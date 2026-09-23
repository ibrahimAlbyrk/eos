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

  // The pane this subtree renders inside (a transcript click / the side panel) or
  // null for shared chrome → fall back to the focused pane. Scopes the per-pane
  // composer popover so one pane's menu doesn't render in the others. The right
  // side panel is now a single shared surface (see SidePanel), not per pane, so
  // its state lives directly on `selection` (panelTab / showSidePanel / …).
  const originPane = useContext(PaneScopeContext);
  const scopePane = originPane ?? pane.focusedLeafId;
  const scopeRef = useRef(scopePane);
  scopeRef.current = scopePane;

  const { openPopoverIn, openPopIn, closePopsIn } = selection;
  // Scope-aware popover open/close: a composer targets its OWN pane, chrome the
  // focused pane. Keeps every call site (ui.openPop(id)/ui.closeAllPops()) intact.
  const openPop = useCallback((id, opts = {}) => openPopIn(scopeRef.current, id, opts), [openPopIn]);
  const closeAllPops = useCallback(() => closePopsIn(scopeRef.current), [closePopsIn]);

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
  }), [
    navigation, selection, pane, composer, attention, search, settings, scopePane,
    openPopoverIn, openPop, closeAllPops,
  ]);
}
