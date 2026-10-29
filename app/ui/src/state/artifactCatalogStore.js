// artifactCatalogStore — every claude.ai artifact of every Claude sign-in
// (GET /api/artifacts, contracts/src/artifacts.ts). Loaded once on first use,
// then read again on every artifacts:change (a bare signal: the catalog itself
// only comes from this Mac's route), when the stream restarts and on window
// focus once a minute has passed, which lets the daemon refresh any sign-in gone
// stale. The routes are this Mac's only, so a view of another computer never
// loads it.

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { isRemoteView } from "../lib/host.js";

const FOCUS_REVALIDATE_MS = 60_000;

const EMPTY = Object.freeze({
  artifacts: Object.freeze([]),
  accounts: Object.freeze([]),
  refreshing: false,
  loaded: false,
  error: null,
  available: !isRemoteView(),
});

let snap = EMPTY;
let catalog = null;
let error = null;
let refreshingHere = false;
let started = false;
let loadedAt = 0;
const subs = new Set();

function emit() {
  snap = Object.freeze({
    artifacts: catalog?.artifacts ?? EMPTY.artifacts,
    accounts: catalog?.accounts ?? EMPTY.accounts,
    refreshing: refreshingHere || Boolean(catalog?.refreshing),
    loaded: catalog !== null,
    error,
    available: !isRemoteView(),
  });
  for (const cb of subs) cb();
}

const isCatalog = (c) => Boolean(c) && Array.isArray(c.artifacts) && Array.isArray(c.accounts);

function setCatalog(next) {
  catalog = next;
  error = null;
  loadedAt = Date.now();
  emit();
}

let inflight = null;
// A change that lands while a read is out may be newer than what that read returns.
let again = false;

function load() {
  if (inflight) {
    again = true;
    return inflight;
  }
  inflight = api.getArtifacts().then(
    (next) => { if (isCatalog(next)) setCatalog(next); },
    (e) => { error = e instanceof Error ? e.message : String(e); emit(); },
  ).finally(() => {
    inflight = null;
    if (again) {
      again = false;
      void load();
    }
  });
  return inflight;
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getSnap = () => snap;

export function ensureArtifactCatalog() {
  if (started || isRemoteView()) return;
  started = true;
  void load();
  window.addEventListener("focus", () => {
    if (Date.now() - loadedAt >= FOCUS_REVALIDATE_MS) void load();
  });
}

// Read again now (the list opening) — the daemon answers from memory and
// refreshes a stale sign-in in the background.
export function revalidateArtifactCatalog() {
  if (!started) ensureArtifactCatalog();
  else void load();
}

// The refresh button: every sign-in re-read now.
export async function refreshArtifactCatalog() {
  if (isRemoteView() || refreshingHere) return;
  started = true;
  refreshingHere = true;
  emit();
  try {
    const next = await api.refreshArtifacts();
    if (isCatalog(next)) {
      catalog = next;
      loadedAt = Date.now();
    }
    error = null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    refreshingHere = false;
    emit();
  }
}

// SSE artifacts:change (useLive).
export function applyArtifactsChange() {
  if (started && !isRemoteView()) void load();
}

export function resyncArtifactCatalog() {
  if (started) void load();
}

// { artifacts, accounts, refreshing, loaded, error, available }. `load` false
// reads what is there without starting the first load (tab labels).
export function useArtifactCatalog({ load = true } = {}) {
  useEffect(() => { if (load) ensureArtifactCatalog(); }, [load]);
  return useSyncExternalStore(subscribe, getSnap, getSnap);
}

// For non-React readers (tab labels between renders).
export function getArtifactCatalog() {
  return snap;
}
