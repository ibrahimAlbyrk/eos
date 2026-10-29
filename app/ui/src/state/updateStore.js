// updateStore — this Mac's in-app update state (the header's update beacon and
// Settings › Updates). Loaded once on first use, then replaced whole by each
// update:change payload; refetched when the stream restarts. A view of another
// computer has none: updates are each computer's own (the routes are local-only).

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { isRemoteView } from "../lib/host.js";

let state = null;
let started = false;
const subs = new Set();

function set(next) {
  state = next;
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getState = () => state;

// null until the first load lands (and always in a view of another computer).
export function useUpdate() {
  return useSyncExternalStore(subscribe, getState, getState);
}

async function refresh() {
  if (isRemoteView()) return;
  const next = await api.getUpdate().catch(() => null);
  if (next?.status) set(next);
}

export function ensureUpdateLoaded() {
  if (started) return;
  started = true;
  void refresh();
}

// SSE update:change (useLive).
export function applyUpdateChange(payload) {
  if (payload?.status) set(payload);
}

export function resyncUpdate() {
  if (started) void refresh();
}

async function act(call) {
  const r = await call();
  if (r.ok && r.body?.status) set(r.body);
  return r;
}

export const updateActions = {
  check: () => act(() => api.checkForUpdate()),
  download: () => act(() => api.downloadUpdate()),
  restart: (when) => act(() => api.restartToUpdate(when)),
  later: () => act(() => api.updateLater()),
  dismissNotice: () => act(() => api.dismissUpdateNotice()),
  setAutoDownload: (on) => act(() => api.patchUpdateSettings({ autoDownload: on })),
};

// Tests seed the store directly.
export function setUpdateState(next) {
  set(next);
}
