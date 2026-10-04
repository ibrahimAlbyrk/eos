// interviewStore — whether the profile interview is open. A module singleton so
// the first-run gate (App.jsx) and the account menu's "Set up profile" open the
// same full-window flow, rendered once at the app root.

import { useSyncExternalStore } from "react";

let open = false;
const subs = new Set();

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getOpen = () => open;

export function useInterviewOpen() {
  return useSyncExternalStore(subscribe, getOpen, getOpen);
}

function set(next) {
  if (open === next) return;
  open = next;
  for (const cb of subs) cb();
}

export const openProfileInterview = () => set(true);
export const closeProfileInterview = () => set(false);
