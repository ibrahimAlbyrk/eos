// memoryViewStore — whether the Memory view has taken over the Agents main area
// (the Archive pattern: the pane tree stays untouched underneath, so closing it
// returns to the exact layout). A module singleton so the sidebar row, the account
// menu and a notification click all drive the same flag.

import { useSyncExternalStore } from "react";
import { setArchiveViewing } from "./archiveStore.js";

let viewing = false;
const subs = new Set();

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getViewing = () => viewing;

export function useMemoryViewing() {
  return useSyncExternalStore(subscribe, getViewing, getViewing);
}

export function setMemoryViewing(on) {
  if (viewing === on) return;
  viewing = on;
  // One main-area takeover at a time.
  if (on) setArchiveViewing(false);
  for (const cb of subs) cb();
}

export function _resetMemoryView() {
  viewing = false;
}
