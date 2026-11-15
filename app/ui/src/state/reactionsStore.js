// reactionsStore — the emoji on the messages of each chat on screen, by row.
//
// A per-row overlay of the loaded transcript window, not a list of the whole
// conversation: a chat's reactions are fetched from the window's oldest row on,
// again for each older stretch that pages in, and kept by `reactions:change`
// after that. A click shows at once and is taken back if the core refuses it.
// Readers subscribe to one row, so a reaction re-renders one message.

import { useCallback, useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { notify } from "../lib/notify.js";
import { noteReactionTold } from "./quietTurns.js";

const NONE = Object.freeze({ user: null, agent: null });
// Chats nobody watches keep their rows for a switch back, this many of them.
const MAX_IDLE_CHATS = 8;

const chats = new Map(); // workerId → chat; insertion order doubles as recency

function chatOf(workerId) {
  let c = chats.get(workerId);
  if (!c) {
    c = {
      workerId,
      rows: new Map(), // rowId → { user, agent }
      subs: new Map(), // rowId → Set<fn>
      // The oldest row asked for; everything newer is covered.
      from: null,
      watchers: 0,
      // Counts every local change and frame; `stamps` holds each row's last one,
      // so a fetch that began earlier does not overwrite what came since.
      seq: 0,
      stamps: new Map(),
    };
    chats.set(workerId, c);
  }
  return c;
}

function evictIdle() {
  const idle = [...chats.values()].filter((c) => c.watchers === 0 && c.subs.size === 0);
  for (let i = 0; i < idle.length - MAX_IDLE_CHATS; i++) chats.delete(idle[i].workerId);
}

function write(c, rowId, change) {
  const prev = c.rows.get(rowId) ?? NONE;
  const next = { ...prev, ...change };
  if (next.user || next.agent) c.rows.set(rowId, next);
  else c.rows.delete(rowId);
  for (const cb of c.subs.get(rowId) ?? []) cb();
}

function touch(c, rowId) {
  c.stamps.set(rowId, ++c.seq);
  return c.seq;
}

const fromWire = (r) => (r.actor === "user" ? { emoji: r.emoji, at: r.at, seen: r.seen === true } : { emoji: r.emoji, at: r.at });

// A reaction read again keeps what only this window knows of it: when it
// appeared here, and a countdown still running on it.
function carry(held, read) {
  if (!read) return null;
  if (held?.emoji !== read.emoji) return read;
  return { ...read, born: held.born, wakesUntil: read.seen ? undefined : held.wakesUntil };
}

async function load(c, fromId, toId, request) {
  const since = c.seq;
  let list;
  try {
    list = await request(c.workerId, { fromId, toId });
  } catch {
    // A chat whose reactions could not be read shows none until the next read.
    return;
  }
  const fetched = new Map();
  for (const r of list) {
    const row = fetched.get(r.rowId) ?? {};
    row[r.actor === "user" ? "user" : "agent"] = fromWire(r);
    fetched.set(r.rowId, row);
  }
  const fresh = (rowId) => (c.stamps.get(rowId) ?? 0) <= since;
  const inRange = (rowId) => rowId >= fromId && (toId == null || rowId <= toId);
  for (const rowId of [...c.rows.keys()]) {
    if (inRange(rowId) && fresh(rowId) && !fetched.has(rowId)) write(c, rowId, { user: null, agent: null });
  }
  for (const [rowId, row] of fetched) {
    if (!fresh(rowId)) continue;
    const held = c.rows.get(rowId) ?? NONE;
    write(c, rowId, { user: carry(held.user, row.user), agent: carry(held.agent, row.agent) });
  }
}

// The transcript of `workerId` is on screen: what is held is read again (a
// switch back may have missed frames). Returns the release.
export function watchReactions(workerId, request = api.getWorkerReactions) {
  const c = chatOf(workerId);
  chats.delete(workerId);
  chats.set(workerId, c);
  c.watchers++;
  if (c.from != null) void load(c, c.from, null, request);
  evictIdle();
  return () => { c.watchers = Math.max(0, c.watchers - 1); };
}

// The window's oldest row is `firstRowId`: reactions from there on are held.
export function coverReactions(workerId, firstRowId, request = api.getWorkerReactions) {
  if (firstRowId == null) return;
  const c = chatOf(workerId);
  if (c.from == null) {
    c.from = firstRowId;
    void load(c, firstRowId, null, request);
  } else if (firstRowId < c.from) {
    const to = c.from - 1;
    c.from = firstRowId;
    void load(c, firstRowId, to, request);
  }
}

// The stream lost frames it could not replay: every watched chat reads again.
export function resyncReactions(request = api.getWorkerReactions) {
  for (const c of chats.values()) {
    if (c.watchers > 0 && c.from != null) void load(c, c.from, null, request);
  }
}

// SSE reactions:change. `emoji: null` is a reaction taken back; the user's own
// arrives again with `seen` once the agent has been told.
export function applyReactionChange(p) {
  if (!p?.workerId || p.rowId == null) return;
  const mine = p.actor === "user";
  if (mine && p.emoji && p.seen === true) noteReactionTold(p.workerId);
  const c = chats.get(p.workerId);
  if (!c) return;
  touch(c, p.rowId);
  if (!p.emoji) return write(c, p.rowId, mine ? { user: null } : { agent: null });
  const held = mine ? c.rows.get(p.rowId)?.user : c.rows.get(p.rowId)?.agent;
  const born = held?.emoji === p.emoji ? held.born : Date.now();
  if (!mine) return write(c, p.rowId, { agent: { emoji: p.emoji, at: p.at, born } });
  const seen = p.seen === true;
  const wakesUntil = !seen && held?.emoji === p.emoji ? held.wakesUntil : undefined;
  write(c, p.rowId, { user: { emoji: p.emoji, at: p.at, seen, born, wakesUntil } });
}

// Puts the user's `emoji` on a message, or takes their reaction back (`null`).
// Resolves to whether the core took it.
export async function setReaction(workerId, rowId, emoji, { put = api.setReaction, remove = api.clearReaction } = {}) {
  const c = chatOf(workerId);
  const before = c.rows.get(rowId)?.user ?? null;
  const now = Date.now();
  write(c, rowId, { user: emoji ? { emoji, at: now, seen: false, born: now } : null });
  const stamp = touch(c, rowId);
  let failure = null;
  try {
    const r = emoji ? await put(workerId, rowId, emoji) : await remove(workerId, rowId);
    if (!r.ok) failure = r.body?.error ?? `status ${r.status}`;
    else if (emoji && r.body?.wakesInMs > 0) {
      const held = c.rows.get(rowId)?.user;
      if (held?.emoji === emoji && !held.seen) write(c, rowId, { user: { ...held, wakesUntil: Date.now() + r.body.wakesInMs } });
    }
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  if (failure === null) return true;
  // Only this click's own change is undone: anything newer stands.
  if (c.stamps.get(rowId) === stamp) write(c, rowId, { user: before });
  notify.error(`Couldn't ${emoji ? "react" : "remove the reaction"}: ${failure}`);
  return false;
}

export function getReactions(workerId, rowId) {
  return chats.get(workerId)?.rows.get(rowId) ?? NONE;
}

function subscribeRow(workerId, rowId, cb) {
  const c = chatOf(workerId);
  let set = c.subs.get(rowId);
  if (!set) c.subs.set(rowId, (set = new Set()));
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0 && c.subs.get(rowId) === set) c.subs.delete(rowId);
  };
}

const noSubscribe = () => () => {};
const none = () => NONE;

// The reactions on one message: `{ user, agent }`, each a reaction or null.
// Without a row (a message that takes none) it is always empty.
export function useReactions(workerId, rowId) {
  const on = Boolean(workerId) && rowId != null;
  const subscribe = useCallback((cb) => (on ? subscribeRow(workerId, rowId, cb) : noSubscribe()), [on, workerId, rowId]);
  const get = on ? () => getReactions(workerId, rowId) : none;
  return useSyncExternalStore(subscribe, get, get);
}

// Test-only: reset the module singleton between cases.
export function _reset() {
  chats.clear();
}
