// Asks before an action that restarts an agent's session (rewind, /compact):
// the restart stops every subagent still running in it. Resolves true at once
// when none is running. One question at a time — SubagentStopDialog (mounted
// once) answers it.

import { useSyncExternalStore } from "react";
import { getSubagents } from "./subagentsStore.js";
import { isRunning } from "../lib/subagentRuns.js";

let pending = null; // { action: "rewind" | "compact", count, resolve }
const subs = new Set();

function emit() {
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function confirmSubagentStop(workerId, action) {
  const count = getSubagents(workerId).filter(isRunning).length;
  if (count === 0) return Promise.resolve(true);
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { action, count, resolve };
    emit();
  });
}

export function answerSubagentStop(ok) {
  const p = pending;
  if (!p) return;
  pending = null;
  emit();
  p.resolve(ok);
}

export function useSubagentStopRequest() {
  return useSyncExternalStore(subscribe, () => pending, () => null);
}
