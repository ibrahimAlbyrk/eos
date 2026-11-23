// movedShortcuts — the one note for a user whose ⌘⌃ digits moved when Eos
// became the first mode (D2): Agents to ⌘⌃2, Code to ⌘⌃3, Machines to ⌘⌃4.
// `eos:shortcutsMoved` is "pending" until the user dismissed it, "seen"
// after, and "seen" from the start for a new user or one already in Eos.

import { useSyncExternalStore } from "react";

export const MOVED_KEY = "eos:shortcutsMoved";

const subs = new Set();

function read() {
  try {
    return localStorage.getItem(MOVED_KEY);
  } catch {
    return "seen";
  }
}

function write(value) {
  try {
    localStorage.setItem(MOVED_KEY, value);
  } catch {}
  for (const cb of subs) cb();
}

// At start, from the view the user last had open: someone who used another
// mode before is told once.
export function noteViewAtStart(stored) {
  if (read() !== null) return;
  write(stored && stored !== "eos" ? "pending" : "seen");
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const pending = () => read() === "pending";

export function useShortcutsMovedPending() {
  return useSyncExternalStore(subscribe, pending, pending);
}

export function dismissShortcutsMoved() {
  write("seen");
}
