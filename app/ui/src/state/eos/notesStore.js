// notesStore — what Eos learned from work (eos:/memory): the screen's head,
// the pages of notes for the filters shown, and the detail of each note
// opened. A memory:change refetches the head, the details it names and the
// pages already loaded (a learned note has no row in the event to place).
// Writes wait for the core's answer.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { notify } from "../../lib/notify.js";
import { putBounded, without } from "./bounded.js";
import { isDevRunRefusal, transport } from "./transport.js";

const DETAILS_KEPT = 50;
const PAGES_KEPT = 10;

// summary: null until loaded. pages: path → { notes, nextCursor }, the pages
// read last. details: id → ExperienceNoteDetail. failed: id → "gone" (404)
// or "error". devRun: a write was refused because this is a dev run.
const EMPTY = { summary: null, summaryFailed: false, pages: {}, pagesFailed: {}, details: {}, failed: {}, devRun: false };
let state = EMPTY;
const asked = new Map(); // path or id → the number of its latest request
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

export function useNotes() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// Only the latest request for a key lands, so answers that cross on the way
// cannot go back in time.
async function latest(key, read) {
  const n = (asked.get(key) ?? 0) + 1;
  asked.set(key, n);
  const r = await read().catch(() => null);
  return asked.get(key) === n ? r : undefined;
}

// The path of a page of notes: { scope: "level" | "level:key", kind, q }.
export function notesPath({ scope, kind, q } = {}) {
  const query = new URLSearchParams(Object.entries({ scope, kind, q }).filter(([, v]) => v)).toString();
  return query ? `${ROUTES.memoryNotes}?${query}` : ROUTES.memoryNotes;
}

export async function refreshMemorySummary() {
  const r = await latest("summary", () => transport.get(ROUTES.memorySummary));
  if (r === undefined) return;
  if (r?.ok && r.body) set({ summary: r.body, summaryFailed: false });
  else if (state.summary === null) set({ summaryFailed: true });
}

export async function loadNotes(path) {
  const r = await latest(path, () => transport.get(path));
  if (r === undefined) return;
  if (r?.ok && Array.isArray(r.body?.notes)) {
    set({ pages: putBounded(state.pages, path, { notes: r.body.notes, nextCursor: r.body.nextCursor }, PAGES_KEPT), pagesFailed: without(state.pagesFailed, path) });
  } else if (!state.pages[path]) {
    set({ pagesFailed: { ...state.pagesFailed, [path]: true } });
  }
}

// The next page of `path`, joined under what it shows.
export async function loadMoreNotes(path) {
  const page = state.pages[path];
  if (!page?.nextCursor) return;
  const more = `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(page.nextCursor)}`;
  const r = await latest(path, () => transport.get(more));
  if (r?.ok && Array.isArray(r.body?.notes)) {
    const notes = [...page.notes, ...r.body.notes.filter((n) => !page.notes.some((o) => o.id === n.id))];
    set({ pages: putBounded(state.pages, path, { notes, nextCursor: r.body.nextCursor }, PAGES_KEPT) });
  }
}

// Every loaded page with the note's row in place of its old one; a forgotten
// note leaves them.
function withRow(row) {
  const pages = {};
  for (const [path, page] of Object.entries(state.pages)) {
    const notes = row.forgottenAt
      ? page.notes.filter((n) => n.id !== row.id)
      : page.notes.map((n) => (n.id === row.id ? row : n));
    pages[path] = { ...page, notes };
  }
  return pages;
}

function putDetail(detail) {
  set({
    details: putBounded(state.details, detail.note.id, detail, DETAILS_KEPT),
    failed: without(state.failed, detail.note.id),
    pages: withRow(detail.note),
  });
}

export async function loadNote(id) {
  const r = await latest(id, () => transport.get(ROUTES.memoryNote(id)));
  if (r === undefined) return;
  if (r?.ok && r.body?.note?.id === id) putDetail(r.body);
  else if (r?.status === 404) set({ details: without(state.details, id), failed: { ...state.failed, [id]: "gone" } });
  else if (!state.details[id]) set({ failed: { ...state.failed, [id]: "error" } });
}

// SSE memory:change { ids, action } (state/eos/live.js).
export function applyMemoryChange(payload) {
  if (state.summary === null && Object.keys(state.pages).length === 0) return;
  void refreshMemorySummary();
  const ids = Array.isArray(payload?.ids) ? payload.ids : [];
  for (const id of ids) if (state.details[id] || state.failed[id]) void loadNote(id);
  if (payload?.action !== "counts" && payload?.action !== "changed") {
    for (const path of Object.keys(state.pages)) void loadNotes(path);
  }
}

export function resyncMemory() {
  if (state.summary !== null) void refreshMemorySummary();
  for (const path of Object.keys(state.pages)) void loadNotes(path);
  for (const id of Object.keys(state.details)) void loadNote(id);
}

// A write's answer, or null when it was refused or failed. A dev run's
// refusal is shown on the screen; any other failure is a toast.
async function write(method, path, body, quiet = () => false) {
  const r = await transport.send(method, path, body).catch(() => null);
  if (r?.ok) return r;
  if (isDevRunRefusal(r)) set({ devRun: true });
  else if (!quiet(r)) notify.error(r?.body?.error ?? "Eos isn't reachable.", { title: "Memory" });
  return null;
}

// The user's own words for a note → true once kept. A note changed
// meanwhile is read again and the edit is not kept.
export async function editNote(id, text, baseRev) {
  let changed = false;
  const r = await write("PUT", ROUTES.memoryNote(id), { text, baseRev }, (r) => (changed = r?.status === 409));
  if (changed) {
    notify.error("The note changed while you edited it. Here it is as it is now.", { title: "Memory" });
    void loadNote(id);
  }
  if (!r) return false;
  putDetail(r.body);
  return true;
}

export async function forgetNote(id) {
  const r = await write("DELETE", ROUTES.memoryNote(id));
  if (r) putDetail(r.body);
}

export async function restoreNote(id) {
  let tooLate = false;
  const r = await write("POST", ROUTES.memoryNoteRestore(id), undefined, (r) => (tooLate = r?.status === 409));
  if (tooLate) notify.error("It was forgotten more than 30 days ago.", { title: "Memory" });
  if (r) {
    putDetail(r.body);
    for (const path of Object.keys(state.pages)) void loadNotes(path);
  } else void loadNote(id);
}

// "Not right" on a note a chat or a run received → true once the core weakened it.
export async function notRightNote(id, { note, runId, workerId } = {}) {
  const r = await write("POST", ROUTES.memoryNoteNotRight(id), { note: note || undefined, runId, workerId });
  if (r) putDetail(r.body);
  return Boolean(r);
}

export function _resetNotes() {
  state = EMPTY;
  asked.clear();
}
