// Outbox — single owner of an outbound message's client-side lifecycle.
// Before this store the lifecycle was smeared across four places (composer
// optimistic map → Composer-local queue mirror → optimisticReconcile → event
// feed) with a visibility gap at every hand-off: the bubble died at the 202
// before the pill fetch landed, and the pill died at the drain seconds before
// the durable user_message appeared. Invariant here: a message the user sent
// is visible in exactly one place until its durable event settles it.
//
// States:
//   sending     — POST in flight, worker believed idle → chat bubble (ts=send).
//   queued      — held in the daemon queue → pill above the input bar.
//   dispatching — left the queue (drain) or dispatched directly → chat bubble
//                 until the durable user_message confirms (or delivery_failed /
//                 the TTL inside filterOptimistic drops it).
//
// Ownership split: pills are settled by the queue endpoint (authoritative
// server mirror) plus clientMsgId echoes; bubbles by the event feed (id →
// text-prefix → failure → TTL). Module store, not a provider: Composer renders
// pills, Messages renders bubbles, useLive's interrupt cancels pills — they
// don't share a React subtree below UiProvider.

import { api } from "../api/client.js";
import { parsePayload } from "../lib/toolLifecycle.js";
import { filterOptimistic } from "../lib/optimisticReconcile.js";

const itemsByWorker = new Map(); // workerId -> [{id, clientMsgId, text, agentText, state, ts, queueId}]
const subs = new Set();
// Per-worker single-flight with a trailing re-run: concurrent queue GETs
// resolve out of order, and a stale empty snapshot wiping a fresh pill was
// the old flicker.
const syncState = new Map(); // workerId -> {inFlight, again}
// Pill X clicked before the 202 named its row — the explicit-intent marker
// settleSend needs to delete that row. ONLY a user dismissal may cancel a
// server row; an item missing for any other reason (TTL, reconcile, purge)
// must leave the row alone or a real queued message would be silently lost.
const dismissedEarly = new Set(); // item ids

let nextId = 0;
const newId = () => `ob-${++nextId}`;

function emit() {
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function itemsFor(workerId) {
  return itemsByWorker.get(workerId) ?? [];
}

function setItems(workerId, list) {
  if (list.length === 0) itemsByWorker.delete(workerId);
  else itemsByWorker.set(workerId, list);
  emit();
}

// `busy` is the caller's best guess from its workers snapshot — presentation
// only (pill vs bubble for the first RTT); the daemon's queued/dispatched
// response corrects it in settleSend. No dispatch decision is made here.
export function beginSend(workerId, { text, agentText, clientMsgId = null, busy = false }) {
  if (!workerId || !text) return null;
  const item = {
    id: newId(),
    clientMsgId,
    text,
    agentText: agentText || text,
    state: busy ? "queued" : "sending",
    ts: Date.now(),
    queueId: null,
  };
  setItems(workerId, [...itemsFor(workerId), item]);
  return item.id;
}

// Maps the daemon's /message decision onto the item: queued → pill carrying
// its row id; dispatched → bubble awaiting the durable event; deduped or
// rejected → drop (the duplicate's original owns the bubble; rejections
// surface via the caller's error handling and the delivery_failed line).
export function settleSend(workerId, itemId, r) {
  const list = itemsFor(workerId);
  const idx = list.findIndex((i) => i.id === itemId);
  if (idx < 0) {
    // The item vanished while the POST was in flight. Cancel the row it just
    // created ONLY when the user explicitly dismissed the pill — any other
    // drop reason must not destroy a genuinely queued message.
    if (dismissedEarly.delete(itemId) && r?.body?.queued && r.body.queueId != null) {
      void api.dismissQueuedMessage(workerId, r.body.queueId);
    }
    return;
  }
  dismissedEarly.delete(itemId);
  const item = list[idx];
  if (r?.body?.queued) {
    const next = [...list];
    next[idx] = { ...item, state: "queued", queueId: r.body.queueId ?? null };
    setItems(workerId, next);
  } else if (r?.ok && !r?.body?.deduped) {
    // Direct dispatch — keep the send-time ts: the bubble must sort above
    // the output this message causes.
    const next = [...list];
    next[idx] = { ...item, state: "dispatching" };
    setItems(workerId, next);
  } else {
    setItems(workerId, list.filter((i) => i.id !== itemId));
  }
}

// Spawn-path boot prompts: dispatched with the spawn itself, no clientMsgId —
// their daemon-appended user_message settles them via the text fallback.
export function addDispatched(workerId, { text, agentText }) {
  if (!workerId || !text) return null;
  const item = {
    id: newId(),
    clientMsgId: null,
    text,
    agentText: agentText || text,
    state: "dispatching",
    ts: Date.now(),
    queueId: null,
  };
  setItems(workerId, [...itemsFor(workerId), item]);
  return item.id;
}

export function dismissPill(workerId, itemId) {
  const list = itemsFor(workerId);
  const item = list.find((i) => i.id === itemId);
  if (!item) return;
  setItems(workerId, list.filter((i) => i.id !== itemId));
  if (item.queueId != null) {
    void api.dismissQueuedMessage(workerId, item.queueId).then(() => syncQueue(workerId));
  } else {
    // The 202 is still in flight — record the intent so settleSend deletes
    // the row once the response names it.
    dismissedEarly.add(itemId);
  }
}

// Web-initiated interrupt: the daemon clears its pending rows before the IDLE
// transition; mirror that instantly. Bubbles stay — the worker flushes their
// pending records on interrupt, so a durable event (or failure/TTL) still
// settles them.
export function cancelQueued(workerId) {
  const list = itemsFor(workerId);
  const kept = list.filter((i) => i.state !== "queued");
  if (kept.length !== list.length) setItems(workerId, kept);
}

export function purgeAgent(workerId) {
  syncState.delete(workerId);
  if (itemsByWorker.delete(workerId)) emit();
}

// Mirror the daemon queue (the only queue authority) into local items.
export async function syncQueue(workerId) {
  if (!workerId) return;
  let s = syncState.get(workerId);
  if (!s) {
    s = { inFlight: false, again: false };
    syncState.set(workerId, s);
  }
  if (s.inFlight) {
    s.again = true;
    return;
  }
  s.inFlight = true;
  try {
    do {
      s.again = false;
      const body = await api.getWorkerQueue(workerId);
      applySnapshot(workerId, Array.isArray(body?.messages) ? body.messages : []);
    } while (s.again);
  } finally {
    s.inFlight = false;
  }
}

function applySnapshot(workerId, rows) {
  const now = Date.now();
  const prev = itemsFor(workerId);
  const next = [];
  const claimed = new Set();
  let changed = false;

  for (const item of prev) {
    if (item.state !== "queued") {
      next.push(item);
      continue;
    }
    if (item.queueId != null) {
      if (rows.some((r) => r.id === item.queueId)) {
        claimed.add(item.queueId);
        next.push(item);
      } else {
        // Row gone without a local dismiss — the drain dispatched it. The
        // pill becomes a chat bubble stamped at detection time: in the
        // creation-domain sort that lands below the previous turn's output
        // and above the new turn's (created strictly later).
        next.push({ ...item, state: "dispatching", ts: now });
        changed = true;
      }
      continue;
    }
    // 202 still in flight — adopt the server row if the snapshot already
    // shows it (text is the only key the queue endpoint exposes).
    const match = rows.find((r) => !claimed.has(r.id) && (r.text === item.agentText || r.text === item.text));
    if (match) {
      claimed.add(match.id);
      next.push({ ...item, queueId: match.id });
      changed = true;
    } else {
      next.push(item);
    }
  }

  // Rows no local item knows (another client, app reload) → materialize pills.
  for (const r of rows) {
    if (claimed.has(r.id)) continue;
    next.push({
      id: newId(),
      clientMsgId: null,
      text: r.text,
      agentText: r.text,
      state: "queued",
      ts: r.ts ?? now,
      queueId: r.id,
    });
    changed = true;
  }

  if (changed) setItems(workerId, next);
}

// Newest event rows (poll or delta). One uniform rule for every item —
// filterOptimistic: keyed items settle only on their clientMsgId echo (an
// older same-text user_message can't kill them), unkeyed ones keep the text
// fallback, and the TTL sweeps anything nothing ever settled (a pill whose
// settle path broke must not survive until a page reload). The id echo also
// covers pills directly: the drain dispatched them, so syncQueue would
// convert-then-drop a moment later anyway.
export function reconcileEvents(workerId, rows) {
  if (!workerId || !Array.isArray(rows)) return;
  const list = itemsFor(workerId);
  if (list.length === 0) return;
  const texts = new Set();
  const ids = new Set();
  const failures = [];
  let clearedTs = 0;
  for (const e of rows) {
    const p = parsePayload(e.payload);
    if (e.type === "user_message") {
      if (p.text) texts.add(p.text);
      for (const cid of p.clientMsgIds ?? []) ids.add(cid);
    }
    // A failed delivery never yields a user_message — the failure event
    // itself must release the bubble.
    if (e.type === "lifecycle" && p.phase === "delivery_failed" && p.text) {
      failures.push({ text: p.text, ts: e.ts });
    }
    // A /clear (conversation_cleared) wipes the conversation. A slash command
    // emits NO user_message to echo, so its optimistic bubble has no settle
    // path — drop anything from before the clear boundary, mirroring the chat's
    // history slice (messageParser hides everything before conversation_cleared).
    if (e.type === "conversation_cleared" && e.ts > clearedTs) clearedTs = e.ts;
  }
  const now = Date.now();
  const kept = list.filter((i) =>
    (!clearedTs || i.ts > clearedTs) &&
    // Pills skip the text fallback entirely: a server-materialized pill is
    // unkeyed, and an old same-text message would drop it on every fetch
    // while syncQueue re-creates it from the still-pending row — a flicker
    // loop. Its row (mirrored by syncQueue) + id echo + failure + TTL govern.
    filterOptimistic([i], { ids, texts: i.state === "queued" ? [] : texts, failures, now }).length > 0,
  );
  if (kept.length !== list.length) setItems(workerId, kept);
}

// Test-only: module state survives between vitest cases otherwise.
export function _reset() {
  itemsByWorker.clear();
  syncState.clear();
  dismissedEarly.clear();
  subs.clear();
  nextId = 0;
}
