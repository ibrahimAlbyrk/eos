// homeDraftStore — the text typed in the Home input, kept per viewer in
// `eos:homeDraft` so leaving Home (or the field) loses nothing. A starter
// chip fills it; Enter's act clears it.

import { useSyncExternalStore } from "react";

export const HOME_DRAFT_KEY = "eos:homeDraft";

let text = null;
const subs = new Set();

// The gallery types into a draft of its own, never the user's.
let inMemory = false;
export function holdHomeDraftInMemory() {
  inMemory = true;
  text = "";
}

function stored() {
  if (inMemory) return "";
  try {
    return localStorage.getItem(HOME_DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}


function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => (text ??= stored());

export function useHomeDraft() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function setHomeDraft(next) {
  text = next;
  if (!inMemory) try {
    if (next) localStorage.setItem(HOME_DRAFT_KEY, next);
    else localStorage.removeItem(HOME_DRAFT_KEY);
  } catch {}
  for (const cb of subs) cb();
}

export function _resetHomeDraft() {
  text = null;
}
