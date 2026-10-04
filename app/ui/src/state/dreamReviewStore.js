// dreamReviewStore — whether the one-at-a-time morning review is open. A module
// singleton so the dream journal and the account menu open the same full-window
// flow, rendered once at the app root.

import { useSyncExternalStore } from "react";

let open = false;
const subs = new Set();

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getOpen = () => open;

export function useDreamReviewOpen() {
  return useSyncExternalStore(subscribe, getOpen, getOpen);
}

function set(next) {
  if (open === next) return;
  open = next;
  for (const cb of subs) cb();
}

export const openDreamReview = () => set(true);
export const closeDreamReview = () => set(false);
