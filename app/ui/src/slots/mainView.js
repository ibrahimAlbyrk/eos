// Which main view, if any, has taken over the Agents main area (Archive, Memory,
// a plugin's view). null = the panes. One at a time; the pane tree stays
// untouched underneath, so closing a view returns to the exact layout.

import { useSyncExternalStore } from "react";

let active = null;
const subs = new Set();

export function getMainView() {
  return active;
}

export function setMainView(id) {
  if (active === id) return;
  active = id;
  for (const cb of subs) cb();
}

// Close `id` only if it is the one showing.
export function closeMainView(id) {
  if (active === id) setMainView(null);
}

export function subscribeMainView(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function useMainView() {
  return useSyncExternalStore(subscribeMainView, getMainView, getMainView);
}

// Test-only.
export function _resetMainView() {
  active = null;
}
