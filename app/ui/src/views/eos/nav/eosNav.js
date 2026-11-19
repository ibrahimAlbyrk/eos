// eosNav — where the user is inside Eos. Every screen has a location string
// (`eos:/…`), which is also what a banner or a notification carries to open it.
// The store keeps the current location with a back and a forward stack, and
// remembers the location across launches (`eos:location`).

import { useSyncExternalStore } from "react";

const SCHEME = "eos:/";
const HOME = SCHEME;
// Where Eos opens when no usable place is remembered.
const START = `${SCHEME}capabilities`;
const STORAGE_KEY = "eos:location";
const BACK_LIMIT = 50;

const ROUTINE_TABS = ["overview", "runs", "blueprint", "learned"];
const MEMORY_TABS = ["about", "work"];
const SURFACE_MODES = ["reshape"];

const INVALID = Symbol("invalid");

// A query value from a fixed set: undefined when absent, INVALID outside it.
function oneOf(query, key, allowed) {
  const value = query.get(key);
  if (value === null) return undefined;
  return allowed.includes(value) ? value : INVALID;
}

// A query value that is free text; an empty one counts as absent.
function text(query, key) {
  return query.get(key) || undefined;
}

function count(value) {
  return /^[1-9]\d*$/.test(value) ? Number(value) : INVALID;
}

// The location without its absent parts; null when a part is invalid.
function location(fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  return entries.some(([, v]) => v === INVALID) ? null : Object.fromEntries(entries);
}

function routine(id, rest, query) {
  if (id === undefined) return { screen: "routines" };
  if (id === "new") return rest.length ? null : { screen: "new-routine" };
  if (rest.length === 0) return location({ screen: "routine", routineId: id, tab: oneOf(query, "tab", ROUTINE_TABS) });
  if (rest.length === 2 && rest[0] === "versions") return location({ screen: "version", routineId: id, version: count(rest[1]) });
  return null;
}

function form(query) {
  const options = {};
  for (const [key, value] of query) if (key.startsWith("opt.") && key.length > 4) options[key.slice(4)] = value;
  const showOnly = query.get("showOnly");
  return location({
    screen: "form",
    routine: text(query, "routine") ?? INVALID,
    item: text(query, "item"),
    note: text(query, "note"),
    options,
    showOnly: showOnly === null ? undefined : showOnly === "1" ? true : INVALID,
    at: text(query, "at"),
    from: text(query, "from"),
  });
}

function match([section, id, ...rest], query) {
  const leaf = rest.length === 0;
  switch (section) {
    case undefined: return { screen: "home" };
    case "needs": return leaf ? (id === undefined ? { screen: "needs" } : { screen: "need", itemId: id }) : null;
    case "routines": return routine(id, rest, query);
    case "runs": return leaf && id !== undefined ? { screen: "run", runId: id } : null;
    case "memory":
      return id === undefined
        ? location({ screen: "memory", tab: oneOf(query, "tab", MEMORY_TABS), note: text(query, "note") })
        : null;
    case "capabilities": return leaf ? (id === undefined ? { screen: "capabilities" } : { screen: "capability", capabilityId: id }) : null;
    case "surfaces": {
      if (!leaf || id === undefined) return null;
      const issue = query.get("issue");
      return location({ screen: "surface", surfaceId: id, issue: issue === null ? undefined : count(issue), mode: oneOf(query, "mode", SURFACE_MODES) });
    }
    case "form": return id === undefined ? form(query) : null;
    default: return null;
  }
}

// `eos:/…` → { screen, …its parts }, or null for a string that is no Eos location.
export function parseLocation(text) {
  if (typeof text !== "string" || !text.startsWith(SCHEME)) return null;
  const rest = text.slice(SCHEME.length);
  const q = rest.indexOf("?");
  const path = q < 0 ? rest : rest.slice(0, q);
  let parts;
  try {
    parts = path === "" ? [] : path.split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.some((p) => p === "")) return null;
  return match(parts, new URLSearchParams(q < 0 ? "" : rest.slice(q + 1)));
}

function withQuery(path, pairs) {
  const query = new URLSearchParams(pairs.filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
  return query ? `${path}?${query}` : path;
}

const segment = encodeURIComponent;

// The location string of a parsed location; parseLocation(buildLocation(l)) equals l.
export function buildLocation(l) {
  switch (l.screen) {
    case "home": return HOME;
    case "needs": return `${SCHEME}needs`;
    case "need": return `${SCHEME}needs/${segment(l.itemId)}`;
    case "routines": return `${SCHEME}routines`;
    case "new-routine": return `${SCHEME}routines/new`;
    case "routine": return withQuery(`${SCHEME}routines/${segment(l.routineId)}`, [["tab", l.tab]]);
    case "version": return `${SCHEME}routines/${segment(l.routineId)}/versions/${l.version}`;
    case "run": return `${SCHEME}runs/${segment(l.runId)}`;
    case "memory": return withQuery(`${SCHEME}memory`, [["tab", l.tab], ["note", l.note]]);
    case "capabilities": return `${SCHEME}capabilities`;
    case "capability": return `${SCHEME}capabilities/${segment(l.capabilityId)}`;
    case "surface": return withQuery(`${SCHEME}surfaces/${segment(l.surfaceId)}`, [["issue", l.issue], ["mode", l.mode]]);
    case "form":
      return withQuery(`${SCHEME}form`, [
        ["routine", l.routine], ["item", l.item], ["note", l.note],
        ...Object.entries(l.options).map(([name, value]) => [`opt.${name}`, value]),
        ["showOnly", l.showOnly ? 1 : undefined], ["at", l.at], ["from", l.from],
      ]);
    default: throw new Error(`no Eos screen ${l.screen}`);
  }
}

// ── The store ───────────────────────────────────────────────────────────────

let current = null; // restored on the first read: entering the mode
let back = [];
let forward = [];
let remembers = true;
const subs = new Set();

function restored() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return parseLocation(stored) ? stored : START;
  } catch {
    return START;
  }
}

function moveTo(next) {
  current = next;
  if (remembers) try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function eosLocation() {
  if (current === null) current = restored();
  return current;
}

export function useEosLocation() {
  return useSyncExternalStore(subscribe, eosLocation, eosLocation);
}

export function openLocation(next) {
  const from = eosLocation();
  if (next === from) return;
  back = [...back, from].slice(-BACK_LIMIT);
  forward = [];
  moveTo(next);
}

export function goBack() {
  if (back.length === 0) return;
  forward = [...forward, eosLocation()];
  const next = back[back.length - 1];
  back = back.slice(0, -1);
  moveTo(next);
}

export function goForward() {
  if (forward.length === 0) return;
  back = [...back, eosLocation()].slice(-BACK_LIMIT);
  const next = forward[forward.length - 1];
  forward = forward.slice(0, -1);
  moveTo(next);
}

// A route from outside the window (a banner, a notification) that names an
// Eos location: Eos opens there.
export function openEosRoute(route, setActiveView) {
  openLocation(route);
  setActiveView("eos");
}

// The sample gallery runs on the app's origin, so it shares the user's storage:
// it starts at `start` and keeps its place in memory, leaving the user's
// remembered place as it is.
export function holdEosNavInMemory(start) {
  remembers = false;
  current = start;
  back = [];
  forward = [];
}

export function _resetEosNav() {
  current = null;
  back = [];
  forward = [];
  remembers = true;
}
