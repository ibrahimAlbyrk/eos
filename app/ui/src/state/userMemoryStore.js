// userMemoryStore — the user's memories (kept + suggested), shared by the Memory
// view, the sidebar avatar's pending dot and the account menu. A module singleton
// read through useSyncExternalStore. Every mutation is the user's (UI token); the
// list then refreshes — from the response or the user-memory:change SSE echo.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";

// memories: null until loaded.
let state = { memories: null, error: null };
const subs = new Set();
let loading = null;
let refreshTimer = null;

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getUserMemoriesState() {
  return state;
}

export function useUserMemories() {
  return useSyncExternalStore(subscribe, getUserMemoriesState, getUserMemoriesState);
}

export const pendingMemories = (s) => (s.memories ?? []).filter((m) => m.status === "suggested");

export async function refreshUserMemories() {
  const memories = await api.listUserMemories().catch(() => null);
  if (memories) set({ memories });
  return memories;
}

export function ensureUserMemoriesLoaded() {
  if (state.memories || loading) return loading ?? Promise.resolve();
  loading = refreshUserMemories().finally(() => { loading = null; });
  return loading;
}

// Runs a mutation; a failure is surfaced, and the list re-read either way.
async function mutate(call, optimistic) {
  if (optimistic && state.memories) set({ memories: optimistic(state.memories) });
  const r = await call().catch((e) => ({ ok: false, status: 0, body: { error: String(e) } }));
  set({ error: r.ok ? null : (r.body?.error ?? `request failed (HTTP ${r.status})`) });
  await refreshUserMemories();
  return r;
}

const without = (id) => (ms) => ms.filter((m) => m.id !== id);
const patched = (id, patch) => (ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m));

export const approveMemory = (id) => mutate(() => api.approveUserMemory(id), patched(id, { status: "active" }));
export const dismissMemory = (id) => mutate(() => api.dismissUserMemory(id), without(id));
export const deleteMemory = (id) => mutate(() => api.deleteUserMemory(id), without(id));
export const approveAllMemories = () =>
  mutate(() => api.approveAllUserMemories(), (ms) => ms.map((m) => ({ ...m, status: "active" })));
export const createMemory = (input) => mutate(() => api.createUserMemory(input));
export const updateMemory = (id, patch) => mutate(() => api.updateUserMemory(id, patch), patched(id, patch));

// SSE user-memory:change — bursts (approve all, an agent suggesting several)
// collapse into one re-read.
export function applyUserMemoryChange() {
  if (!state.memories || refreshTimer) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; void refreshUserMemories(); }, 150);
}

export function resyncUserMemories() {
  if (state.memories) void refreshUserMemories();
}

export function _resetUserMemories() {
  state = { memories: null, error: null };
  loading = null;
  clearTimeout(refreshTimer);
  refreshTimer = null;
}
