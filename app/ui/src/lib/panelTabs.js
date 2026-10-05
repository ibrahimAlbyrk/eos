// Pure open-tabs reducers for the right side panel. A panel holds an ordered
// list of open tab types + the active one + an activation history (most recent
// last); opening a tab appends and activates it, closing the active one goes
// back to the previously active tab. Shared by the global panel
// state and the per-pane panels so the tab logic lives in exactly one place.

export const EMPTY_TABS = { openTabs: [], activeTab: null, tabHistory: [] };

// Types that can have MULTIPLE independent instances open at once (each its own
// session). Their tab id is `${type}:${n}`; every other type is a singleton
// whose id IS its type. Kept here so the id scheme lives with the reducers.
export const MULTI_TAB_TYPES = new Set(["terminal", "newtab"]);

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

// A page gets its own tab keyed by the page id, like a file tab.
export function pageTabId(id) {
  return `page:${id}`;
}

export function pageIdOf(id) {
  return id && tabType(id) === "page" ? id.slice("page:".length) : null;
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
  return openTab(state, newTabId(state, type));
}

// The id a NEW tab of `type` gets: a multi type's lowest free instance number,
// anything else (a singleton type, or a full id like a page tab) as given.
export function newTabId(state, type) {
  if (!MULTI_TAB_TYPES.has(type)) return type;
  const used = new Set(state.openTabs.filter((t) => tabType(t) === type).map(tabNumber));
  let n = 1;
  while (used.has(n)) n += 1;
  return `${type}:${n}`;
}

// Turn one tab into another in place (a new-tab launcher becoming what it
// opened): same slot, now active. When the target is already open elsewhere the
// old tab just closes and the target activates; an old tab that isn't open
// degrades to a plain open.
export function replaceTab(state, oldId, newId) {
  const i = state.openTabs.indexOf(oldId);
  if (i === -1) return openTab(state, newId);
  if (oldId === newId) return activateTab(state, newId);
  if (state.openTabs.includes(newId)) return activateTab(closeTab(state, oldId), newId);
  const openTabs = state.openTabs.map((t) => (t === oldId ? newId : t));
  const history = (state.tabHistory ?? []).filter((t) => t !== oldId);
  return { openTabs, activeTab: newId, tabHistory: pushHistory(history, newId) };
}

// The tabs a panel keeps mounted: every open tab already shown once (so it keeps
// its state while another is shown), plus the active one while the panel is on
// screen. A tab restored from a previous session mounts only when first shown.
export function mountedTabs(seen, openTabs, activeTab, shown) {
  return openTabs.filter((t) => seen.has(t) || (shown && t === activeTab));
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
