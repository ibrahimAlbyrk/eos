// dreamStore — Dreaming's live status (running? progress, last run, next run, why
// blocked) plus the run log and the chats the user turned off. Shared by the Memory
// view, Settings › Dreaming and the account menu. A module singleton read through
// useSyncExternalStore; dream:change over SSE re-reads it.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";

// status/log: null until loaded.
let state = { status: null, runs: null, excluded: [], error: null };
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

export function getDreamState() {
  return state;
}

export function useDreams() {
  return useSyncExternalStore(subscribe, getDreamState, getDreamState);
}

export async function refreshDreamStatus() {
  const status = await api.getDreamStatus().catch(() => null);
  if (status) set({ status });
  return status;
}

export async function refreshDreamLog() {
  const r = await api.listDreams().catch(() => null);
  if (r) set({ runs: r.runs, excluded: r.excluded });
  return r;
}

export function ensureDreamStatusLoaded() {
  if (state.status || loading) return loading ?? Promise.resolve();
  loading = refreshDreamStatus().finally(() => { loading = null; });
  return loading;
}

export async function dreamNow() {
  const r = await api.dreamNow().catch((e) => ({ ok: false, status: 0, body: { error: String(e) } }));
  set({ error: r.ok ? null : (r.body?.error ?? `couldn't start (HTTP ${r.status})`) });
  await refreshDreamStatus();
  return r;
}

export async function stopDream() {
  await api.stopDream().catch(() => null);
}

export async function setDreamExclusion(workerId, excluded) {
  set({ excluded: excluded ? [...new Set([...state.excluded, workerId])] : state.excluded.filter((id) => id !== workerId) });
  const r = await api.setDreamExclusion(workerId, excluded).catch(() => null);
  if (r?.ok) set({ excluded: r.body.excluded });
}

// SSE dream:change — progress ticks arrive in bursts; one re-read per burst. The
// log refreshes only when it's open (runs loaded) and a run ended.
export function applyDreamChange(evt) {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshDreamStatus();
    if (state.runs && evt?.status !== "running") void refreshDreamLog();
  }, 120);
}

export function resyncDreams() {
  if (state.status) void refreshDreamStatus();
  if (state.runs) void refreshDreamLog();
}

export function _resetDreams() {
  state = { status: null, runs: null, excluded: [], error: null };
  loading = null;
  clearTimeout(refreshTimer);
  refreshTimer = null;
}
