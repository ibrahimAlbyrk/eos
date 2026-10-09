// The daemon's visual-answers settings (GET /api/settings/genui) as the kit
// needs them — today only the optional logo.dev key. Loaded once; the Settings
// screen pushes changes in with setGenuiSettings.

import { api } from "../../api/client.js";

let current = { level: "balanced", apps: true, locationShare: false, logoDevKey: null };
let loadStarted = false;
const subs = new Set();

export function getGenuiSettings() {
  return current;
}

export function setGenuiSettings(next) {
  if (!next || typeof next !== "object") return;
  current = { ...current, ...next };
  for (const cb of subs) cb(current);
}

export function subscribeGenuiSettings(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function ensureGenuiSettings() {
  if (loadStarted) return;
  loadStarted = true;
  api.getGenuiSettings().then(setGenuiSettings).catch(() => { loadStarted = false; });
}
