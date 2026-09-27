// Live context-compaction state, keyed by workerId. Module singleton like
// loopCheckStore — the Messages view writes it, other surfaces read it:
//   compacting — a compaction is running (the composer shows that sends queue)
//   fx         — the live animation's stage, so the card it lands in knows to
//                start blank and let the dust write it:
//                { stage: "running" | "assembling" | "settling", since, cardId? }
// No entry = nothing running / the card renders in its resting state.

import { useSyncExternalStore } from "react";

const compacting = new Map();
const fx = new Map();
const subs = new Set();

function emit() {
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function setCompacting(workerId, on) {
  if (!workerId || compacting.has(workerId) === Boolean(on)) return;
  if (on) compacting.set(workerId, true);
  else compacting.delete(workerId);
  emit();
}

export function isCompacting(workerId) {
  return compacting.has(workerId);
}

export function setFx(workerId, next) {
  if (!workerId) return;
  if (next) fx.set(workerId, next);
  else if (!fx.delete(workerId)) return;
  emit();
}

export function fxFor(workerId) {
  return fx.get(workerId) ?? null;
}

export function useCompacting(workerId) {
  return useSyncExternalStore(subscribe, () => isCompacting(workerId), () => false);
}

export function useFx(workerId) {
  return useSyncExternalStore(subscribe, () => fxFor(workerId), () => null);
}
