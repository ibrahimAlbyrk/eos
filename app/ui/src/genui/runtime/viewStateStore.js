// Per-view UI state (filters, ticks, the current step, input values): one copy
// per view id shared by every mounted instance (the inline view and its side
// panel tab), persisted through GET/PUT /api/genui/views/:id/state (debounced)
// and kept in step by the "genui:change" SSE. Selection is ephemeral and shared
// the same way, but never leaves the client.
//
// A view still streaming has no id yet (a "local:" key): its state lives here
// only until the id is minted.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../../api/client.js";

const VIEW_ID_RE = /^v_[A-Za-z0-9]{12}$/;
const PUT_DEBOUNCE_MS = 400;
const STATE_MAX_BYTES = 32 * 1024;
const EMPTY = Object.freeze({});

// viewId -> { state, selection, loaded, loading, dirty: Set<key>, timer, putting, mounts }
const entries = new Map();
const subs = new Set();

export const isPersistentViewId = (id) => typeof id === "string" && VIEW_ID_RE.test(id);

function entryOf(viewId) {
  let e = entries.get(viewId);
  if (!e) {
    e = { state: EMPTY, selection: EMPTY, loaded: false, loading: false, dirty: new Set(), timer: 0, putting: false, mounts: 0 };
    entries.set(viewId, e);
  }
  return e;
}

function emit(viewId) {
  for (const cb of subs) cb(viewId);
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getViewState(viewId) {
  return entries.get(viewId)?.state ?? EMPTY;
}

export function getSelection(viewId) {
  return entries.get(viewId)?.selection ?? EMPTY;
}

// Server state under the keys this client changed and hasn't saved yet.
function mergeRemote(e, remote) {
  const base = remote && typeof remote === "object" && !Array.isArray(remote) ? remote : {};
  if (!e.dirty.size) return base;
  const out = { ...base };
  for (const k of e.dirty) {
    if (Object.prototype.hasOwnProperty.call(e.state, k)) out[k] = e.state[k];
    else delete out[k];
  }
  return out;
}

export async function loadViewState(viewId, { force = false } = {}) {
  if (!isPersistentViewId(viewId)) return;
  const e = entryOf(viewId);
  if (e.loading || (e.loaded && !force)) return;
  e.loading = true;
  try {
    const r = await api.getGenuiViewState(viewId);
    if (r?.state) {
      e.state = mergeRemote(e, r.state);
      emit(viewId);
    }
  } catch {
    // An unreachable daemon keeps the local state; the next resync retries.
  } finally {
    e.loading = false;
    e.loaded = true;
  }
}

function schedulePut(viewId) {
  const e = entryOf(viewId);
  clearTimeout(e.timer);
  e.timer = setTimeout(() => void putNow(viewId), PUT_DEBOUNCE_MS);
}

async function putNow(viewId) {
  const e = entries.get(viewId);
  if (!e || !e.dirty.size) return;
  if (e.putting) { schedulePut(viewId); return; }
  const sent = new Set(e.dirty);
  const state = e.state;
  let body;
  try {
    body = JSON.stringify(state);
  } catch {
    return;
  }
  if (new TextEncoder().encode(body).length > STATE_MAX_BYTES) {
    console.warn(`[genui] state of ${viewId} is over 32 KB — kept on this screen only`);
    return;
  }
  e.putting = true;
  try {
    const r = await api.putGenuiViewState(viewId, state);
    if (r?.ok) {
      for (const k of sent) if (e.state[k] === state[k]) e.dirty.delete(k);
    }
  } catch {
    // Kept dirty — the next change or resync tries again.
  } finally {
    e.putting = false;
  }
}

export function setViewState(viewId, key, value) {
  if (!viewId || typeof key !== "string" || !key) return;
  const e = entryOf(viewId);
  if (Object.is(e.state[key], value)) return;
  const next = { ...e.state };
  if (value === undefined) delete next[key];
  else next[key] = value;
  e.state = next;
  if (isPersistentViewId(viewId)) {
    e.dirty.add(key);
    schedulePut(viewId);
  }
  emit(viewId);
}

export function setSelection(viewId, collection, id) {
  if (!viewId || !collection) return;
  const e = entryOf(viewId);
  const cur = e.selection[collection] ?? null;
  const next = id ?? null;
  if (cur === next) return;
  e.selection = { ...e.selection, [collection]: next };
  emit(viewId);
}

// A view streamed under a local key got its id: its state moves over.
export function adoptLocalState(localKey, viewId) {
  const local = entries.get(localKey);
  if (!local || !isPersistentViewId(viewId) || localKey === viewId) return;
  entries.delete(localKey);
  const e = entryOf(viewId);
  if (local.state !== EMPTY) {
    e.state = { ...local.state, ...e.state };
    for (const k of Object.keys(local.state)) e.dirty.add(k);
    schedulePut(viewId);
  }
  if (local.selection !== EMPTY) e.selection = { ...local.selection, ...e.selection };
  emit(viewId);
}

// SSE "genui:change" {viewId, state}: another client (or our own PUT) wrote it.
export function applyViewStateChange({ viewId, state } = {}) {
  if (!isPersistentViewId(viewId) || !state || typeof state !== "object") return;
  const e = entries.get(viewId);
  if (!e) return;
  e.state = mergeRemote(e, state);
  e.loaded = true;
  emit(viewId);
}

// After a stream gap: re-read the views on screen. One that isn't mounted
// is marked stale instead, so it re-reads when it next mounts — a long chat
// doesn't GET every view it ever showed on each reconnect.
export function resyncViewStates() {
  for (const [id, e] of entries) {
    if (!isPersistentViewId(id)) continue;
    if (e.mounts > 0) void loadViewState(id, { force: true });
    else e.loaded = false;
  }
}

// A mounted instance of the view (the hook calls it); returns the release.
export function retainViewState(viewId) {
  if (!viewId) return () => {};
  const e = entryOf(viewId);
  e.mounts++;
  return () => { e.mounts = Math.max(0, e.mounts - 1); };
}

// [state, setState(key, value)] for one view, loading it on first use.
export function useViewState(viewId) {
  const sub = useCallback((cb) => subscribe((id) => { if (id === viewId) cb(); }), [viewId]);
  const snap = useCallback(() => getViewState(viewId), [viewId]);
  const state = useSyncExternalStore(sub, snap, snap);
  useEffect(() => {
    const unmount = retainViewState(viewId);
    void loadViewState(viewId);
    return unmount;
  }, [viewId]);
  const set = useCallback((key, value) => setViewState(viewId, key, value), [viewId]);
  return [state, set];
}

export function useViewSelection(viewId) {
  const sub = useCallback((cb) => subscribe((id) => { if (id === viewId) cb(); }), [viewId]);
  const snap = useCallback(() => getSelection(viewId), [viewId]);
  return useSyncExternalStore(sub, snap, snap);
}

// Test-only.
export function _reset() {
  for (const e of entries.values()) clearTimeout(e.timer);
  entries.clear();
  subs.clear();
}

export function _flushPuts() {
  return Promise.all([...entries.keys()].map((id) => {
    const e = entries.get(id);
    clearTimeout(e.timer);
    return putNow(id);
  }));
}
