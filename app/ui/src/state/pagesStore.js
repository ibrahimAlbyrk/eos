// pagesStore — pages (markdown notes shared with agents) for the side panel: a
// summary list per project (the new-tab launcher) and the full page behind each
// open editor. Module singleton (projectsStore idiom) fed by the API and the
// `pages:change` SSE, so an agent's edit shows up while the page is open.

import { useEffect, useSyncExternalStore } from "react";
import { api } from "../api/client.js";

const ALL = "*";
// A page the daemon no longer has — the editor shows a closed state, not a spinner.
export const DELETED = Object.freeze({ deleted: true });

const lists = new Map(); // project (or ALL) -> PageSummary[]
const pages = new Map(); // id -> Page | DELETED
const subs = new Set();
let version = 0;

function emit() {
  version += 1;
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const keyOf = (project) => project ?? ALL;

export const getList = (project) => lists.get(keyOf(project)) ?? null;
export const getPage = (id) => pages.get(id) ?? null;
const getVersion = () => version;

export async function refreshList(project) {
  try {
    lists.set(keyOf(project), await api.listPages(project ? { project } : {}));
    emit();
  } catch {
    // daemon unreachable — keep what we had
  }
}

export async function loadPage(id) {
  try {
    pages.set(id, await api.getPage(id));
  } catch {
    pages.set(id, DELETED);
  }
  emit();
  return getPage(id);
}

export async function createPage(input) {
  const r = await api.createPage(input);
  if (!r.ok) throw new Error(r.body?.error ?? `create page → ${r.status}`);
  pages.set(r.body.page.id, r.body.page);
  emit();
  void refreshList(input.project ?? null);
  return r.body.page;
}

// Save the editor's title/body against the rev it was based on. A 409 hands
// back the newer page (an agent edited it meanwhile) for the caller to merge.
export async function savePage(id, { title, body }, baseRev) {
  const r = await api.updatePage(id, { title, body, baseRev });
  if (r.ok) {
    pages.set(id, r.body.page);
    emit();
    return { ok: true, page: r.body.page };
  }
  if (r.status === 409 && r.body?.page) {
    pages.set(id, r.body.page);
    emit();
    return { ok: false, conflict: r.body.page };
  }
  return { ok: false, error: r.body?.error ?? `save page → ${r.status}` };
}

export async function removePage(id) {
  const r = await api.deletePage(id);
  if (!r.ok) throw new Error(r.body?.error ?? `delete page → ${r.status}`);
  pages.set(id, DELETED);
  for (const [key, list] of lists) lists.set(key, list.filter((p) => p.id !== id));
  emit();
}

// SSE pages:change — refetch the lists it lands in and the page itself when an
// editor holds an older rev (our own saves already carry the new rev).
export function applyChange(evt) {
  if (!evt?.id) return;
  for (const key of new Set([keyOf(evt.project), ALL])) {
    if (lists.has(key)) void refreshList(key === ALL ? null : key);
  }
  const cur = pages.get(evt.id);
  if (!cur) return;
  if (evt.action === "deleted") { pages.set(evt.id, DELETED); emit(); return; }
  if (cur === DELETED || cur.rev < evt.rev) void loadPage(evt.id);
}

// The stream missed events — refetch everything on screen.
export function resyncPages() {
  for (const key of lists.keys()) void refreshList(key === ALL ? null : key);
  for (const id of pages.keys()) void loadPage(id);
}

export function usePageList(project) {
  const key = keyOf(project);
  const get = () => lists.get(key) ?? null;
  const list = useSyncExternalStore(subscribe, get, get);
  useEffect(() => { void refreshList(project); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}

export function usePage(id) {
  const get = () => (id ? pages.get(id) ?? null : null);
  const page = useSyncExternalStore(subscribe, get, get);
  useEffect(() => { if (id && !pages.has(id)) void loadPage(id); }, [id]);
  return page;
}

// Re-render on any page change (tab labels read titles via getPage).
export const usePagesVersion = () => useSyncExternalStore(subscribe, getVersion, getVersion);

// Test-only: reset the module singleton between cases.
export function _reset() {
  lists.clear();
  pages.clear();
  subs.clear();
  version = 0;
}
