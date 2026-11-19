// inboxStore — what needs the user (eos:/needs, the sidebar's count): the
// first page of items in Needs you's order with the counts, the chats in
// Agents that wait, and the detail of each item opened. An inbox:change reads
// that one item again while it still waits, or drops it from the list.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { afterFirstPaint } from "../../lib/firstPaint.js";
import { without } from "./bounded.js";
import { transport } from "./transport.js";

const WAITING = new Set(["open", "later"]);
const ATTENTION_ORDER = { interrupt: 0, digest: 1, silent: 2 };

// list: null until loaded, then { items, counts, agentsWaiting, nextCursor }
// (InboxList). details: id → InboxItemDetail. failed: id → "gone" or "error".
const EMPTY = { list: null, listFailed: false, details: {}, failed: {} };
let state = EMPTY;
let started = false;
const asked = new Map(); // id → the number of its latest detail request
const subs = new Set();

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => state;

export function useInbox() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// Needs you's order (03 §4.5): open before later, then by attention, then
// newest first, then the higher id.
function rank(item) {
  return (item.state === "later" ? 3 : 0) + (ATTENTION_ORDER[item.attention] ?? 2);
}

export function byNeedsOrder(a, b) {
  return rank(a) - rank(b) || b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function bump(map, key, by) {
  if (key == null) return map;
  const n = (map?.[key] ?? 0) + by;
  return n > 0 ? { ...map, [key]: n } : without(map ?? {}, key);
}

// The counts with `item` taken out (by -1) or put in (by +1); an item that no
// longer waits counts nowhere.
function counted(counts, item, by) {
  if (!item || !WAITING.has(item.state)) return counts;
  return {
    ...counts,
    later: counts.later + (item.state === "later" ? by : 0),
    byKind: bump(counts.byKind, item.kind, by),
    byRoutine: bump(counts.byRoutine, item.routineId, by),
  };
}

// The list with `row` where it now belongs, or out of it when it no longer
// waits; the counts follow, and `open` is the core's own count.
function withItem(list, id, row, open) {
  const before = list.items.find((i) => i.id === id);
  const rest = list.items.filter((i) => i.id !== id);
  const items = row && WAITING.has(row.state) ? [...rest, row].sort(byNeedsOrder) : rest;
  // A new item past the first page's end belongs to a later page.
  const shown = list.nextCursor && !before && row && items[items.length - 1] === row ? rest : items;
  const counts = counted(counted(list.counts, before, -1), row, +1);
  return { ...list, items: shown, counts: { ...counts, open: open ?? counts.open } };
}

export async function refreshInbox() {
  const r = await transport.get(ROUTES.inbox).catch(() => null);
  if (r?.ok && Array.isArray(r.body?.items)) set({ list: r.body, listFailed: false });
  else if (state.list === null) set({ listFailed: true });
}

export function ensureInboxLoaded() {
  if (started) return;
  started = true;
  void afterFirstPaint(refreshInbox);
}

// Reads one item; its row in the list follows. Only the latest request for an
// id lands, so answers that cross on the way cannot go back in time.
export async function loadInboxItem(id, { keep = true, open } = {}) {
  const n = (asked.get(id) ?? 0) + 1;
  asked.set(id, n);
  const r = await transport.get(ROUTES.inboxItem(id)).catch(() => null);
  if (asked.get(id) !== n) return;
  if (r?.ok && r.body?.item?.id === id) {
    set({
      details: keep || state.details[id] ? { ...state.details, [id]: r.body } : state.details,
      failed: without(state.failed, id),
      list: state.list && withItem(state.list, id, r.body.item, open),
    });
  } else if (r?.status === 404) {
    set({ details: without(state.details, id), failed: { ...state.failed, [id]: "gone" }, list: state.list && withItem(state.list, id, null, open) });
  } else if (keep && !state.details[id]) {
    set({ failed: { ...state.failed, [id]: "error" } });
  }
}

// SSE inbox:change { id, kind, state, routineId?, rev, open }: an item that
// still waits is read again; one that does not leaves the list at once, and
// an open detail is read again to say who answered it.
export function applyInboxChange(payload) {
  const id = payload?.id;
  if (typeof id !== "string") return;
  const held = Boolean(state.details[id]);
  if (WAITING.has(payload.state)) {
    if (state.list || held) void loadInboxItem(id, { keep: held, open: payload.open });
    return;
  }
  if (state.list) set({ list: withItem(state.list, id, null, payload.open) });
  if (held) void loadInboxItem(id);
}

export function resyncInbox() {
  if (started) void refreshInbox();
  for (const id of Object.keys(state.details)) void loadInboxItem(id);
}

export function _resetInbox() {
  state = EMPTY;
  started = false;
  asked.clear();
}
