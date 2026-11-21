// syncStore — Settings › Sync status (GET /api/sync). Every change to it arrives
// whole as the sync:change SSE payload, so the store never refetches after the first load.
// What each domain fills of the vault (GET /api/sync/usage) is read again after each pass.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";

let status = null;
const subs = new Set();

let usage = [];

function set(next) {
  const passed = next?.lastSyncAt !== status?.lastSyncAt;
  status = next;
  for (const cb of subs) cb();
  if (passed && next?.phase !== "off") void refreshUsage();
}

function setUsage(domains) {
  usage = domains;
  for (const cb of subs) cb();
}

const getUsage = () => usage;

// The domains at their vault budget: their new records wait on this Mac.
export function useSyncFull() {
  return useSyncExternalStore(subscribe, getUsage, getUsage).filter((d) => d.full).map((d) => d.name);
}

export async function refreshUsage() {
  const next = await api.getSyncUsage().catch(() => null);
  if (next && Array.isArray(next.domains)) setUsage(next.domains);
}

// For tests and the gallery.
export function setSyncUsage(domains) {
  setUsage(domains);
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
