// Pure open-tabs reducers for the right side panel. A panel holds an ordered
// list of open tab types + the active one + an activation history (most recent
// last); opening a tab appends and activates it, closing the active one goes
// back to the previously active tab. Shared by the global panel
// state and the per-pane panels so the tab logic lives in exactly one place.

export const EMPTY_TABS = { openTabs: [], activeTab: null, tabHistory: [] };

// Types that can have MULTIPLE independent instances open at once (each its own
// session). Their tab id is `${type}:${n}`; every other type is a singleton
// whose id IS its type. Kept here so the id scheme lives with the reducers.
export const MULTI_TAB_TYPES = new Set(["terminal"]);

// The panel type behind a tab id ("terminal:2" -> "terminal", "files" -> "files").
export function tabType(id) {
  const i = id.indexOf(":");
  return i === -1 ? id : id.slice(0, i);
}

// A file opened from anywhere gets its OWN tab, keyed by its absolute path, so
// several files sit side by side as separate pills.
export function fileTabId(path) {
  return `file:${path}`;
}

// The file path behind a file tab id, or null for any other tab (or none).
export function filePathOf(id) {
  return id && tabType(id) === "file" ? id.slice("file:".length) : null;
}

// The instance number in a tab id, or 1 for a bare/singleton id.
function tabNumber(id) {
  const i = id.indexOf(":");
  return i === -1 ? 1 : Number(id.slice(i + 1)) || 1;
}

function pushHistory(history = [], tab) {
  return [...history.filter((t) => t !== tab), tab];
}

// Activate an already-open tab (pill click); absent or already-active is a no-op.
export function activateTab(state, tab) {
  if (!state.openTabs.includes(tab) || state.activeTab === tab) return state;
  return { openTabs: state.openTabs, activeTab: tab, tabHistory: pushHistory(state.tabHistory, tab) };
}

// Open (or re-activate) a tab: append when absent, always make it active.
export function openTab(state, tab) {
  const openTabs = state.openTabs.includes(tab) ? state.openTabs : [...state.openTabs, tab];
  return { openTabs, activeTab: tab, tabHistory: pushHistory(state.tabHistory, tab) };
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

// Close a tab: drop it. When it was the active one, activate the most recently
// active tab still open; with no history, the neighbor that slides into its
// slot, else the new last tab, else none. Closing a non-active tab leaves the
// active one untouched.
export function closeTab(state, tab) {
  const i = state.openTabs.indexOf(tab);
  if (i === -1) return state;
  const openTabs = state.openTabs.filter((t) => t !== tab);
  const tabHistory = (state.tabHistory ?? []).filter((t) => t !== tab && openTabs.includes(t));
  const activeTab = state.activeTab === tab
    ? (tabHistory[tabHistory.length - 1] ?? openTabs[i] ?? openTabs[openTabs.length - 1] ?? null)
    : state.activeTab;
  return { openTabs, activeTab, tabHistory };
}
