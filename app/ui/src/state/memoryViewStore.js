// memoryViewStore — whether the Memory view has taken over the Agents main area
// (the Archive pattern: the pane tree stays untouched underneath, so closing it
// returns to the exact layout), and which of its pages shows: the memories or the
// dream log. A module singleton so the account menu, Settings and a notification
// click all drive the same state.

import { useSyncExternalStore } from "react";
import { setArchiveViewing } from "./archiveStore.js";

let snapshot = { viewing: false, page: "memory" };
const subs = new Set();

function set(patch) {
  snapshot = { ...snapshot, ...patch };
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getViewing = () => snapshot.viewing;
const getPage = () => snapshot.page;

export function useMemoryViewing() {
  return useSyncExternalStore(subscribe, getViewing, getViewing);
}

export function useMemoryPage() {
  return useSyncExternalStore(subscribe, getPage, getPage);
}

export function setMemoryViewing(on) {
  if (snapshot.viewing === on) return;
  // One main-area takeover at a time.
  if (on) setArchiveViewing(false);
  set(on ? { viewing: true } : { viewing: false, page: "memory" });
}

// "memory" | "log"
export function setMemoryPage(page) {
  if (snapshot.page !== page) set({ page });
}

export function _resetMemoryView() {
  snapshot = { viewing: false, page: "memory" };
}
