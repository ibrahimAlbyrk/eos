// User projects (~/.eos/projects.json via the daemon) + the one project modal's
// state. A module singleton (same idiom as archiveStore) because the sidebar,
// the composer's project picker and the modal host all read/write it.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";

let state = { projects: [], loaded: false, modal: null };
const subs = new Set();
let fetched = false;

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  if (!fetched) { fetched = true; refreshProjects(); }
  return () => subs.delete(cb);
}

export const getProjectsState = () => state;

export async function refreshProjects() {
  try {
    const { projects } = await api.listProjects();
    set({ projects, loaded: true });
  } catch {
    set({ loaded: true });
  }
}

// Throws with the daemon's message so the modal can show it inline.
export async function saveProject(project) {
  const r = await api.saveProject(project);
  if (!r.ok) throw new Error(r.body?.error ?? `Save failed (${r.status})`);
  await refreshProjects();
  return r.body.project;
}

export async function deleteProject(id) {
  const r = await api.deleteProject(id);
  if (!r.ok) throw new Error(r.body?.error ?? `Remove failed (${r.status})`);
  await refreshProjects();
}

// modal: { project?, path? } — a registered project to edit, a bare folder to
// promote into one, or neither to create from scratch. onSaved(project) runs
// after a successful save.
export const openProjectModal = (modal = {}) => set({ modal });
export const closeProjectModal = () => set({ modal: null });

export const useProjects = () => useSyncExternalStore(subscribe, getProjectsState, getProjectsState);
