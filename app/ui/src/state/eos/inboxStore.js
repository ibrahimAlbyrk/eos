// inboxStore — what needs the user (eos:/needs, the sidebar's count): the
// first page of items in Needs you's order with the counts, the chats in
// Agents that wait, and the detail of each item opened. An inbox:change reads
// that one item again while it still waits, or drops it from the list.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { afterFirstPaint } from "../../lib/firstPaint.js";
import { without } from "./bounded.js";
import { notify } from "../../lib/notify.js";
import { isDevRunRefusal, transport } from "./transport.js";

const WAITING = new Set(["open", "later"]);
const ATTENTION_ORDER = { interrupt: 0, digest: 1, silent: 2 };

// list: null until loaded, then { items, counts, agentsWaiting, nextCursor }
// (InboxList). details: id → InboxItemDetail. failed: id → "gone" or "error".
// refused: id → { answeredBy?, state? }, an answer another device gave first.
// devRun: an answer was refused because this is a dev run. lastAnswered:
// the item answered last, null when none, undefined until asked. offline:
// the core gave no answer at all to the last request (G35).
const EMPTY = {
  list: null, listFailed: false, details: {}, failed: {}, refused: {}, devRun: false, lastAnswered: undefined, offline: false,
};
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

// What the core answering at all or not says about the connection.
function heard(r) {
  if (state.offline !== (r === null)) set({ offline: r === null });
  return r;
}

const read = (path) => transport.get(path).catch(() => null).then(heard);

export async function refreshInbox() {
  const r = await read(ROUTES.inbox);
  if (r?.ok && Array.isArray(r.body?.items)) set({ list: r.body, listFailed: false });
  else if (state.list === null) set({ listFailed: true });
}

export function ensureInboxLoaded() {
  if (started) return;
  started = true;
  void afterFirstPaint(refreshInbox);
}

// The item answered last, for the line an empty Needs you shows; read once.
export async function loadLastAnswered() {
  if (state.lastAnswered !== undefined) return;
  const r = await transport.get(`${ROUTES.inbox}?state=answered`).catch(() => null);
  set({ lastAnswered: r?.ok ? (r.body?.items?.[0] ?? null) : null });
}

// Reads one item; its row in the list follows. Only the latest request for an
// id lands, so answers that cross on the way cannot go back in time.
export async function loadInboxItem(id, { keep = true, open } = {}) {
  const n = (asked.get(id) ?? 0) + 1;
  asked.set(id, n);
  const r = await read(ROUTES.inboxItem(id));
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

// An item answered here through a route of its own (a run's permission ask, a
// suggestion about the user), which sends no inbox:change: it leaves the list.
function dropShown(id) {
  const shown = state.list?.items.find((i) => i.id === id);
  set({
    details: without(state.details, id),
    list: state.list && withItem(state.list, id, null, state.list.counts.open - (shown?.state === "open" ? 1 : 0)),
  });
}

// A 409 on a write: another device answered first, or the item was replaced
// (kept in `refused`, the item read again to say who or by what), or it
// changed since it was read (read again).
function conflicted(id, r) {
  if (r.body?.answeredBy || r.body?.state) set({ refused: { ...state.refused, [id]: { answeredBy: r.body.answeredBy, state: r.body.state } } });
  void loadInboxItem(id);
}

// One answer → true once the core took it. No answer at all shows as
// Reconnecting on the screen. A 409 says another device answered
// first (the item is read again to show who) or that the item changed since it
// was read (it is read again); a dev run's refusal is said on the screen; any
// other failure is a toast.
async function answerWith(id, method, path, body) {
  const r = heard(await transport.send(method, path, body).catch(() => null));
  if (r?.ok) return true;
  if (r === null) return false;
  if (r?.status === 409) {
    conflicted(id, r);
  } else if (isDevRunRefusal(r)) {
    set({ devRun: true });
  } else {
    notify.error(r.body?.error ?? "Eos could not do that.", { title: "Needs you" });
  }
  return false;
}

const revOf = (id) => state.details[id]?.item.rev ?? state.list?.items.find((i) => i.id === id)?.rev;

// POST /api/inbox/{id}/answer with the item's rev; `answer` is tagged by kind.
export function answerInboxItem(id, answer) {
  return answerWith(id, "POST", ROUTES.inboxAnswer(id), { rev: revOf(id), answer });
}

// Sends a draft: as it is, or the whole edited ResultDoc `doc`. A 409
// "replaced" is kept in `refused` and the item read again, which names the
// newer draft; "changed" reads the item again.
export function sendInboxDraft(id, doc) {
  return answerWith(id, "POST", ROUTES.inboxSend(id), doc ? { rev: revOf(id), doc } : { rev: revOf(id) });
}

// PUT draft: keeps the user's edits of a draft in the core, so another
// device sees them. The answer is the item's row with its new rev; a
// refusal is handled as an answer's is.
export async function saveInboxDraft(id, doc) {
  const r = heard(await transport.send("PUT", ROUTES.inboxDraft(id), { rev: revOf(id), doc }).catch(() => null));
  if (r?.ok && r.body?.id === id) {
    const detail = state.details[id];
    if (detail) set({ details: { ...state.details, [id]: { ...detail, item: r.body, working: doc } } });
    return true;
  }
  if (r === null) return false;
  if (r.status === 409) conflicted(id, r);
  return false;
}

export function discardInboxItem(id) {
  return answerWith(id, "POST", ROUTES.inboxDiscard(id), { rev: revOf(id) });
}

// Puts an item aside at once; the list is read again when the core refuses.
export async function laterInboxItem(id) {
  const item = state.list?.items.find((i) => i.id === id);
  if (item?.state === "open") set({ list: withItem(state.list, id, { ...item, state: "later" }, state.list.counts.open - 1) });
  if (!(await answerWith(id, "POST", ROUTES.inboxLater(id), {}))) void refreshInbox();
}

// A run's permission ask, answered through the recorded decision route:
// Allow once or Deny, never "always" (it would widen every chat's policy).
export async function decideRunAsk(id, pendingId, allow) {
  const body = allow ? { decision: "allow" } : { decision: "deny", reason: "denied in Needs you" };
  const ok = await answerWith(id, "POST", ROUTES.pendingDecision(pendingId), body);
  if (ok) dropShown(id);
  return ok;
}

// A suggestion about the user, kept or dismissed through its recorded routes.
export async function decideSuggestion(id, memoryId, keep) {
  const ok = await answerWith(id, "POST", keep ? ROUTES.userMemoryApprove(memoryId) : ROUTES.userMemoryDismiss(memoryId), {});
  if (ok) dropShown(id);
  return ok;
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
