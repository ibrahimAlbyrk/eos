// memoryViewStore — whether the Memory view has taken over the Agents main area
// (it is the "memory" main view; see slots/mainView.js), and which of its pages
// shows: the memories or the dream log. A module singleton so the account menu,
// Settings and a notification click all drive the same state.

import { useSyncExternalStore } from "react";
import { closeMainView, getMainView, setMainView, subscribeMainView } from "../slots/mainView.js";

const MEMORY_VIEW = "memory";
let page = "memory";
const subs = new Set();

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getViewing = () => getMainView() === MEMORY_VIEW;
const getPage = () => page;

// Leaving the view resets it to its first page.
subscribeMainView(() => {
  if (!getViewing() && page !== "memory") {
    page = "memory";
    for (const cb of subs) cb();
  }
});

export function useMemoryViewing() {
  return useSyncExternalStore(subscribeMainView, getViewing, getViewing);
}

export function useMemoryPage() {
  return useSyncExternalStore(subscribe, getPage, getPage);
}

export function setMemoryViewing(on) {
  if (on) setMainView(MEMORY_VIEW);
  else closeMainView(MEMORY_VIEW);
}

// "memory" | "log"
export function setMemoryPage(next) {
  if (page === next) return;
  page = next;
  for (const cb of subs) cb();
}

export function _resetMemoryView() {
  closeMainView(MEMORY_VIEW);
  page = "memory";
}
