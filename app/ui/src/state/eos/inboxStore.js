// inboxStore — what needs the user (eos:/needs, the sidebar's count): the
// first page of items in Needs you's order with the counts, the chats in
// Agents that wait, and the detail of each item opened. An inbox:change reads
// that one item again while it still waits, or drops it from the list.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { afterFirstPaint } from "../../lib/firstPaint.js";
import { without } from "./bounded.js";
import { notify } from "../../lib/notify.js";
import { isDevRunRefusal, recipientsUnconfirmed, transport } from "./transport.js";

const WAITING = new Set(["open", "later"]);
const ATTENTION_ORDER = { interrupt: 0, digest: 1, silent: 2 };

// list: null until loaded, then { items, counts, agentsWaiting, nextCursor }
// (InboxList). details: id → InboxItemDetail. failed: id → "gone" or "error".
// refused: id → { answeredBy?, state? }, an answer another device gave first.
// devRun: an answer was refused because this is a dev run. lastAnswered:
// the item answered last, null when none, undefined until asked. offline:
// the core gave no answer at all to the last request (G35). sendNotes:
// delivery id → what the user did to a send here and how it ended:
// "wrong", "undone", "partial" or "cannot_undo". A draft's deliveries are
// its detail's `deliveries`, kept current from inbox:delivery. unconfirmed:
// item id → the 409 recipients_unconfirmed body its Resume answered (D53).
const EMPTY = {
  list: null, listFailed: false, details: {}, failed: {}, refused: {}, devRun: false, lastAnswered: undefined, offline: false, sendNotes: {},
  unconfirmed: {},
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
// changed or went stale since it was read (read again, which shows why). A
// Resume refused until recipients are confirmed is kept for the card, the
// item unchanged. Any other 409 is the core's plain reason, such as a
// recipient removed from the routine: a toast in its words.
function conflicted(id, r) {
  const refusal = recipientsUnconfirmed(r);
  if (refusal) {
    set({ unconfirmed: { ...state.unconfirmed, [id]: refusal } });
    return;
  }
  if (r.body?.answeredBy || r.body?.state) set({ refused: { ...state.refused, [id]: { answeredBy: r.body.answeredBy, state: r.body.state } } });
  else if (r.body?.rev === undefined && r.body?.error !== "stale") notify.error(r.body?.error ?? "Eos could not do that.", { title: "Needs you" });
  void loadInboxItem(id);
}

// One answer → true once the core took it. No answer at all shows as
// Reconnecting on the screen. A 409 says another device answered
// first (the item is read again to show who) or that the item changed since it
// was read (it is read again); a dev run's refusal is said on the screen; any
// other failure is a toast.
async function answerWith(id, method, path, body, took = () => {}) {
  const r = heard(await transport.send(method, path, body).catch(() => null));
  if (r?.ok) {
    took(r.body);
    return true;
  }
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

// The draft saves in flight, by item id: each save and a send wait for the
// one before, so each goes on the rev the last one left.
const saving = new Map();

// Sends a draft: as it is, or the whole edited ResultDoc `doc`, once a save
// in flight has landed; `anyway` once the user saw that its subject moved
// on. A 409 "replaced" is kept in `refused` and the item read again, which
// names the newer draft; "changed" and "stale" read the item again.
export async function sendInboxDraft(id, doc, anyway = false) {
  await saving.get(id);
  const body = { rev: revOf(id), ...(doc ? { doc } : {}), ...(anyway ? { confirmStale: true } : {}) };
  return answerWith(id, "POST", ROUTES.inboxSend(id), body, (answer) => {
    const detail = state.details[id];
    if (!detail || !Array.isArray(answer?.deliveries)) return;
    set({ details: { ...state.details, [id]: { ...detail, deliveries: answer.deliveries } } });
    // The draft still reads open here until the core's change arrives.
    if (isHolding(id)) void loadInboxItem(id);
  });
}

// Whether a send of the draft `id` waits out its hold, so it can be stopped.
export function isHolding(id) {
  return Boolean(state.details[id]?.deliveries?.some((d) => d.state === "holding"));
}

// SSE inbox:delivery { id, itemId?, runId, state, sendAt? }: the send of a
// draft on screen moves at once; one that went out is read again for how
// long it can be taken back.
export function applyInboxDelivery(payload) {
  const detail = state.details[payload?.itemId];
  if (!detail || typeof payload.id !== "string") return;
  const moved = { id: payload.id, state: payload.state, ...(payload.sendAt != null ? { sendAt: payload.sendAt } : {}) };
  const known = detail.deliveries ?? [];
  const deliveries = known.some((d) => d.id === payload.id)
    ? known.map((d) => (d.id === payload.id ? { ...d, ...moved } : d))
    : [...known, moved];
  set({ details: { ...state.details, [payload.itemId]: { ...detail, deliveries } } });
  if (payload.state === "sent") void loadInboxItem(payload.itemId);
}

const noted = (deliveryId, note) => set({ sendNotes: note ? { ...state.sendNotes, [deliveryId]: note } : without(state.sendNotes, deliveryId) });

// One write about a send of the draft `itemId`; the draft is read again
// after it, as the core left it. The answer's body, or null when it did not
// land: a 409 cannot_undo is noted beside the send, a dev run's refusal is
// said on the screen, any other refusal is a toast.
async function deliveryWrite(itemId, deliveryId, path) {
  const r = heard(await transport.send("POST", path, {}).catch(() => null));
  if (r !== null) void loadInboxItem(itemId);
  if (r?.ok) return r.body ?? {};
  if (r === null) return null;
  if (r.body?.error === "cannot_undo") noted(deliveryId, "cannot_undo");
  else if (isDevRunRefusal(r)) set({ devRun: true });
  else notify.error(r.body?.error ?? "Eos could not do that.", { title: "Needs you" });
  return null;
}

// Stops a send in its hold; the draft opens again for the user.
export async function stopDelivery(itemId, deliveryId) {
  return (await deliveryWrite(itemId, deliveryId, ROUTES.inboxDeliveryStop(deliveryId))) !== null;
}

// Takes back a send inside its channel's window.
export async function undoDelivery(itemId, deliveryId) {
  const answer = await deliveryWrite(itemId, deliveryId, ROUTES.inboxDeliveryUndo(deliveryId));
  if (answer) noted(deliveryId, answer.partial ? "partial" : "undone");
  return answer !== null;
}

// Says a send was wrong, once: it is noted before it goes, so a second
// press sends nothing, and the note goes when the core refused it.
export async function flagDeliveryWrong(itemId, deliveryId) {
  if (state.sendNotes[deliveryId] === "wrong") return false;
  const before = state.sendNotes[deliveryId];
  noted(deliveryId, "wrong");
  const done = (await deliveryWrite(itemId, deliveryId, ROUTES.inboxDeliveryWrong(deliveryId))) !== null;
  if (!done) noted(deliveryId, before);
  return done;
}

// PUT draft: keeps the user's edits of a draft in the core, so another
// device sees them. The answer is the item's row with its new rev; a
// refusal is handled as an answer's is.
export function saveInboxDraft(id, doc) {
  const saved = (saving.get(id) ?? Promise.resolve()).then(() => putDraft(id, doc));
  saving.set(id, saved);
  void saved.finally(() => {
    if (saving.get(id) === saved) saving.delete(id);
  });
  return saved;
}

async function putDraft(id, doc) {
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
  saving.clear();
  started = false;
  asked.clear();
}
