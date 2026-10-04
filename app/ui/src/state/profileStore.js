// profileStore — the user's profile, shared by the sidebar avatar, the account
// menu, Settings › Profile and the first-run interview. A module singleton read
// through useSyncExternalStore (the accountsStore idiom).
//
// Saves are optimistic and serialized: the change shows at once, each PUT carries
// the revision the previous one produced, and a 409 (another window saved first)
// adopts the daemon's copy and re-applies the same patch once.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { mergeProfilePatch } from "../lib/profileText.js";

// profile: null until loaded. loaded: a load was attempted (even a failed one —
// gates must not wait forever). status: idle | saving | saved | error.
let state = { profile: null, loaded: false, status: "idle", error: null };
const subs = new Set();
let loading = null;
let chain = Promise.resolve();

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getProfileState() {
  return state;
}

export function useProfile() {
  return useSyncExternalStore(subscribe, getProfileState, getProfileState);
}

export async function refreshProfile() {
  const profile = await api.getProfile().catch(() => null);
  set(profile ? { profile, loaded: true } : { loaded: true });
  return profile;
}

export function ensureProfileLoaded() {
  if (state.profile || loading) return loading ?? Promise.resolve();
  loading = refreshProfile().finally(() => { loading = null; });
  return loading;
}

export function saveProfile(patch) {
  if (state.profile) set({ profile: mergeProfilePatch(state.profile, patch) });
  set({ status: "saving", error: null });
  chain = chain.then(() => put(patch));
  return chain;
}

async function put(patch, retried = false) {
  const base = state.profile?.rev;
  const r = await api.updateProfile(patch, base).catch((e) => ({ ok: false, status: 0, body: { error: String(e) } }));
  if (r.ok) {
    set({ profile: r.body.profile, status: "saved" });
    return { ok: true };
  }
  if (r.status === 409 && r.body?.profile && !retried) {
    set({ profile: mergeProfilePatch(r.body.profile, patch) });
    return put(patch, true);
  }
  const error = r.body?.error ?? `save failed (HTTP ${r.status})`;
  set({ status: "error", error });
  await refreshProfile();
  return { ok: false, error };
}

export async function setProfileAvatar(file) {
  const r = await api.uploadProfileAvatar(file);
  if (r.ok) set({ profile: r.body.profile, error: null });
  else set({ error: r.body?.error ?? `upload failed (HTTP ${r.status})` });
  return r;
}

export async function clearProfileAvatar() {
  const r = await api.deleteProfileAvatar();
  if (r.ok) set({ profile: r.body.profile });
  return r;
}

// SSE profile:change — another window or the interview saved.
export function applyProfileChange(evt) {
  if (!state.profile || (evt?.rev ?? 0) > state.profile.rev) void refreshProfile();
}

export function resyncProfile() {
  if (state.profile) void refreshProfile();
}

export function _resetProfile() {
  state = { profile: null, loaded: false, status: "idle", error: null };
  loading = null;
  chain = Promise.resolve();
}
