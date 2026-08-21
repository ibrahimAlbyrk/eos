// chatAttachmentsStore — the whole-conversation "Files in Chat" list, keyed by
// workerId. A module singleton (like ptyPanelStore) so the toggle, the panel,
// and any future consumer share one source of truth across subtrees.
//
// Two sources, unioned by path (earliest sighting wins — mirrors the daemon's
// server-side union so the live path and a refetch agree):
//   1. Baseline: GET /workers/:id/attachments once on attach (full history —
//      covers rows the bounded live window has already trimmed).
//   2. Live: eventsStore's onNewest folds in attachments from newly-appended
//      user_message rows via the shared parser, so a file sent while the panel
//      is open appears without a refetch.

import { api } from "../api/client.js";
import { attach as attachEvents } from "./eventsStore.js";
import { parseAttachmentMessage } from "../lib/attachmentTokens.js";
import { parsePayload } from "../lib/messageParser.js";

const EMPTY = Object.freeze({ attachments: Object.freeze([]), loaded: false });
const entries = new Map(); // workerId -> entry

function entryOf(workerId) {
  let e = entries.get(workerId);
  if (!e) {
    e = { workerId, byPath: new Map(), loaded: false, attachers: 0, detachEvents: null, subs: new Set(), snapshot: EMPTY };
    entries.set(workerId, e);
  }
  return e;
}

// Earlier by (ts, messageId) — the conversation position. The first sighting of
// a path wins, so a later row never displaces the entry that introduced it.
function earlier(a, b) {
  return a.ts < b.ts || (a.ts === b.ts && a.messageId < b.messageId);
}

function foldAttachment(e, parsed, messageId, ts) {
  const cand = { label: parsed.label, kind: parsed.kind, path: parsed.path, messageId, ts };
  const cur = e.byPath.get(parsed.path);
  if (cur && !earlier(cand, cur)) return false;
  e.byPath.set(parsed.path, cand);
  return true;
}

function foldRows(e, rows) {
  let changed = false;
  for (const r of rows ?? []) {
    if (r.type !== "user_message") continue;
    const text = parsePayload(r.payload).text ?? "";
    for (const a of parseAttachmentMessage(text).attachments) {
      if (foldAttachment(e, a, r.id, r.ts)) changed = true;
    }
  }
  return changed;
}

function publish(e) {
  const attachments = [...e.byPath.values()].sort((a, b) => (a.ts - b.ts) || (a.messageId - b.messageId));
  e.snapshot = { attachments, loaded: e.loaded };
  for (const cb of e.subs) cb();
}

async function loadBaseline(e) {
  let list = [];
  try {
    list = await api.getWorkerAttachments(e.workerId);
  } catch {
    // fail-soft: an empty baseline still lets the live fold populate the list
  }
  if (Array.isArray(list)) {
    for (const a of list) foldAttachment(e, a, a.messageId, a.ts);
  }
  e.loaded = true;
  publish(e);
}

export function subscribe(workerId, cb) {
  const e = entryOf(workerId);
  e.subs.add(cb);
  return () => { e.subs.delete(cb); };
}

// Stable reference between publishes — useSyncExternalStore contract.
export function getSnapshot(workerId) {
  return entries.get(workerId)?.snapshot ?? EMPTY;
}

// Ref-counted: the first attacher loads the baseline and wires the live fold;
// the last detach tears the eventsStore listener down (the cached union stays
// for an instant re-show).
export function attach(workerId) {
  const e = entryOf(workerId);
  e.attachers++;
  if (e.attachers === 1) {
    void loadBaseline(e);
    e.detachEvents = attachEvents(workerId, {
      onNewest: (wid, rows) => {
        if (wid !== e.workerId) return;
        if (foldRows(e, rows)) publish(e);
      },
    });
  }
  return () => {
    e.attachers = Math.max(0, e.attachers - 1);
    if (e.attachers === 0) {
      e.detachEvents?.();
      e.detachEvents = null;
    }
  };
}

// Test-only: reset the module singleton between cases.
export function _reset() {
  entries.clear();
}
