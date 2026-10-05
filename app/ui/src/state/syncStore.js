// syncStore — Settings › Sync status (GET /api/sync). Every change to it arrives
// whole as the sync:change SSE payload, so the store never refetches after the first load.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";

let status = null;
const subs = new Set();

function set(next) {
  status = next;
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getStatus = () => status;

export function useSyncStatus() {
  return useSyncExternalStore(subscribe, getStatus, getStatus);
}

export async function refreshSync() {
  const next = await api.getSync().catch(() => null);
  if (next) set(next);
  return next;
}

// SSE sync:change (useLive).
export function applySyncChange(payload) {
  if (payload && typeof payload === "object" && payload.phase) set(payload);
}

// The stream restarted (events may be missed) — refetch if anyone has looked.
export function resyncSync() {
  if (status) void refreshSync();
}

// A create/join/leave answer is the new status.
export function setSyncStatus(next) {
  if (next?.phase) set(next);
}
