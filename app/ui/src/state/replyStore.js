import { useSyncExternalStore } from "react";

// The message each agent's composer is replying to, keyed by worker id. Module
// singleton because the reply button (transcript) and the reply card (composer)
// render in different subtrees of a pane; keying by worker keeps a split layout
// routing each reply to its own agent's composer and survives agent switches.
const targets = new Map(); // workerId -> { rowId, role, text, ts }
const subs = new Set();

function emit() {
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getReplyTarget(workerId) {
  return targets.get(workerId) ?? null;
}

export function setReplyTarget(workerId, target) {
  if (!workerId || !target) return;
  targets.set(workerId, target);
  emit();
}

export function clearReplyTarget(workerId) {
  if (targets.delete(workerId)) emit();
}

export function useReplyTarget(workerId) {
  const get = () => getReplyTarget(workerId);
  return useSyncExternalStore(subscribe, get, get);
}

// Test-only: reset the module singleton between cases.
export function _reset() {
  targets.clear();
  subs.clear();
}
