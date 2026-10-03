// browserHistoryStore — the sites the browser panel visited, for the new-tab
// launcher's Suggested row. Ranked by frecency (visit count decayed by age) and
// kept per viewer in localStorage (cm:browserHistory) — a convenience, so a
// cleared store just starts over. Fed by browserPanelStore whenever a tab lands
// on a new URL; a later title/favicon for the same URL only updates the entry.

import { useSyncExternalStore } from "react";

const KEY = "cm:browserHistory";
const MAX_ENTRIES = 60;
const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAVICON = 8000; // data-URI chars; bigger icons fall back to a monogram

let entries = null; // key -> { url, title, favicon, count, last }
const subs = new Set();
let snapshot = null; // cached suggestions; null = recompute (an empty list is a valid result)

function load() {
  if (entries) return entries;
  entries = new Map();
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "[]");
    for (const e of Array.isArray(raw) ? raw : []) {
      if (e && typeof e.url === "string" && Number.isFinite(e.count) && Number.isFinite(e.last)) entries.set(keyOf(e.url), e);
    }
  } catch {
    // corrupt/absent storage — start clean
  }
  return entries;
}

function save() {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify([...entries.values()]));
  } catch {
    // storage disabled or over quota — history is best-effort
  }
}

function emit() {
  snapshot = null;
  for (const cb of subs) cb();
}

// Only real web pages are worth suggesting.
function keyOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

const score = (e, now) => e.count * 0.5 ** ((now - e.last) / HALF_LIFE_MS);

export function recordVisit({ url, title, favicon }, now = Date.now()) {
  const key = keyOf(url);
  if (!key) return;
  const map = load();
  const e = map.get(key) ?? { url: key, title: "", favicon: null, count: 0, last: now };
  e.count += 1;
  e.last = now;
  applyMeta(e, title, favicon);
  map.set(key, e);
  if (map.size > MAX_ENTRIES) {
    const keep = [...map.entries()].sort((a, b) => score(b[1], now) - score(a[1], now)).slice(0, MAX_ENTRIES);
    entries = new Map(keep);
  }
  save();
  emit();
}

export function updateMeta({ url, title, favicon }) {
  const e = load().get(keyOf(url));
  if (!e || !applyMeta(e, title, favicon)) return;
  save();
  emit();
}

function applyMeta(e, title, favicon) {
  let changed = false;
  if (title && title !== e.title && title !== e.url) { e.title = title; changed = true; }
  if (favicon && favicon !== e.favicon && favicon.length <= MAX_FAVICON) { e.favicon = favicon; changed = true; }
  return changed;
}

export function suggestions(limit = 4, now = Date.now()) {
  return [...load().values()]
    .sort((a, b) => score(b, now) - score(a, now))
    .slice(0, limit)
    .map((e) => {
      const host = new URL(e.url).host;
      return { ...e, host, local: /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|$)/.test(host) };
    });
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getSnapshot() {
  snapshot ??= suggestions();
  return snapshot;
}

export const useSuggestions = () => useSyncExternalStore(subscribe, getSnapshot);

// Test-only: reset the module singleton between cases.
export function _reset() {
  entries = null;
  snapshot = null;
  subs.clear();
}
