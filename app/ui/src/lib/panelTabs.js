// Pure open-tabs reducers for the right side panel. A panel holds an ordered
// list of open tab types + the active one; opening a tab appends and activates
// it, closing removes it and activates a neighbor. Shared by the global panel
// state and the per-pane panels so the tab logic lives in exactly one place.

export const EMPTY_TABS = { openTabs: [], activeTab: null };

// Open (or re-activate) a tab: append when absent, always make it active.
export function openTab(state, tab) {
  const openTabs = state.openTabs.includes(tab) ? state.openTabs : [...state.openTabs, tab];
  return { openTabs, activeTab: tab };
}

// Close a tab: drop it. When it was the active one, activate the neighbor that
// slides into its slot (its old right neighbor), else the new last tab, else
// none. Closing a non-active tab leaves the active one untouched.
export function closeTab(state, tab) {
  const i = state.openTabs.indexOf(tab);
  if (i === -1) return state;
  const openTabs = state.openTabs.filter((t) => t !== tab);
  const activeTab = state.activeTab === tab
    ? (openTabs[i] ?? openTabs[openTabs.length - 1] ?? null)
    : state.activeTab;
  return { openTabs, activeTab };
}
