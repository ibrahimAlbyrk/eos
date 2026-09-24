import { useSyncExternalStore } from "react";

// Which panes have their docked Environment panel open. Module singleton because
// the header toggle and the docked panel render in different subtrees of a pane.
const openPanes = new Set();
const subs = new Set();

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function toggleEnvPanel(paneId) {
  if (openPanes.has(paneId)) openPanes.delete(paneId);
  else openPanes.add(paneId);
  for (const cb of subs) cb();
}

export function useEnvPanelOpen(paneId) {
  const get = () => openPanes.has(paneId);
  return useSyncExternalStore(subscribe, get, get);
}
