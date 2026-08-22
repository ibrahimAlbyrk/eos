// homeStore — module-singleton for the Home tab's conversation list + current
// selection (same idiom as archiveStore/sidebarPrefsStore). Home conversations
// are root worker rows with agent_role="home"; the daemon exposes them at /home.
// The transcript itself streams through the reused <Messages> component; this
// store only owns the list and which conversation is open.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";

const SELECTED_KEY = "cm:homeSelected";
const MODEL_KEY = "cm:homeModel";
const EFFORT_KEY = "cm:homeEffort";

let state = {
  conversations: [],
  selectedId: localStorage.getItem(SELECTED_KEY) || null,
  // Pre-spawn config for the NEXT conversation — Home's own, deliberately not
  // ui.composer's (that one is the Code view's spawn config). Once a
  // conversation exists its worker row owns model/effort and the composer's
  // pills read/write it there.
  model: localStorage.getItem(MODEL_KEY) || "opus",
  effort: localStorage.getItem(EFFORT_KEY) || "high",
  loaded: false,
};

const listeners = new Set();
function emit() {
  state = { ...state };
  for (const l of listeners) l();
}

export function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function getSnapshot() {
  return state;
}
export function useHome() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export async function refreshHome() {
  try {
    const list = await api.listHomeSessions();
    state = { ...state, conversations: Array.isArray(list) ? list : [], loaded: true };
    emit();
  } catch {
    state = { ...state, loaded: true };
    emit();
  }
}

export function selectHome(id) {
  if (state.selectedId === id) return;
  state = { ...state, selectedId: id };
  if (id) localStorage.setItem(SELECTED_KEY, id);
  else localStorage.removeItem(SELECTED_KEY);
  emit();
}

export function setHomeConfig(patch) {
  state = { ...state, ...patch };
  if (patch.model) localStorage.setItem(MODEL_KEY, patch.model);
  if (patch.effort) localStorage.setItem(EFFORT_KEY, patch.effort);
  emit();
}

// Create an empty conversation (optionally seeded with a first prompt) and select
// it. Returns the new id, or null on failure.
export async function createHome(prompt) {
  const { model, effort } = state;
  const r = await api.spawnHome({ model, effort, ...(prompt ? { prompt } : {}) });
  const id = r?.body?.id ?? r?.id ?? null;
  if (id) {
    selectHome(id);
    await refreshHome();
  }
  return id;
}

export async function removeHome(id) {
  await api.deleteHome(id);
  if (state.selectedId === id) selectHome(null);
  await refreshHome();
}
