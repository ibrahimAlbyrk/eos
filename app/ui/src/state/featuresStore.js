// featuresStore — what Eos offers on the computer its daemon runs on
// (GET /api/ui-config → features). remote = pairing with other computers and
// phones: Machines, Remote access, Transfer. posixShell = agents' sh commands
// can run (false on Windows without Git for Windows). useLive applies it on the first
// load; until then, and for a daemon that doesn't say, everything is on — only
// an explicit false hides a feature. Module singleton (the accountsStore idiom).

import { useSyncExternalStore } from "react";

export function normalizeFeatures(features) {
  return { remote: features?.remote !== false, posixShell: features?.posixShell !== false };
}

let state = normalizeFeatures(null);
const subs = new Set();

export function applyFeatures(features) {
  const next = normalizeFeatures(features);
  if (Object.keys(next).every((k) => next[k] === state[k])) return;
  state = next;
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getFeatures() {
  return state;
}

// For code outside React (registries, providers); components use useFeature so
// they re-render once the daemon has answered.
export function hasFeature(name) {
  return state[name] !== false;
}

export function useFeature(name) {
  return useSyncExternalStore(subscribe, () => hasFeature(name), () => hasFeature(name));
}

// The whole set — one object until the daemon's answer changes it.
export function useFeatures() {
  return useSyncExternalStore(subscribe, getFeatures, getFeatures);
}
