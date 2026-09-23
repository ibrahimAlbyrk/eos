// Pure open-tabs reducers for the right side panel. A panel holds an ordered
// list of open tab types + the active one; opening a tab appends and activates
// it, closing removes it and activates a neighbor. Shared by the global panel
// state and the per-pane panels so the tab logic lives in exactly one place.

export const EMPTY_TABS = { openTabs: [], activeTab: null };

// Types that can have MULTIPLE independent instances open at once (each its own
// session). Their tab id is `${type}:${n}`; every other type is a singleton
// whose id IS its type. Kept here so the id scheme lives with the reducers.
export const MULTI_TAB_TYPES = new Set(["terminal"]);

// The panel type behind a tab id ("terminal:2" -> "terminal", "files" -> "files").
export function tabType(id) {
  const i = id.indexOf(":");
  return i === -1 ? id : id.slice(0, i);
}

// The instance number in a tab id, or 1 for a bare/singleton id.
function tabNumber(id) {
  const i = id.indexOf(":");
  return i === -1 ? 1 : Number(id.slice(i + 1)) || 1;
}

// Open (or re-activate) a tab: append when absent, always make it active.
export function openTab(state, tab) {
  const openTabs = state.openTabs.includes(tab) ? state.openTabs : [...state.openTabs, tab];
  return { openTabs, activeTab: tab };
}

// Open a NEW tab from the + menu. Multi types always get a fresh instance (the
// lowest free number among their open tabs), so each + click adds a tab; every
// other type is a singleton, so this just re-activates the one that's open.
export function openNewTab(state, type) {
  if (!MULTI_TAB_TYPES.has(type)) return openTab(state, type);
  const used = new Set(state.openTabs.filter((t) => tabType(t) === type).map(tabNumber));
  let n = 1;
  while (used.has(n)) n += 1;
  return openTab(state, `${type}:${n}`);
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
