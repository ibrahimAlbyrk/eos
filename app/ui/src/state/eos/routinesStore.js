// routinesStore — the user's routines (the sidebar, eos:/routines), the
// detail of each one opened, and the writes the routine page makes. The list
// loads once after the first paint; a routine:change carries the routine's
// row and is applied as it comes, so a change never reads the list again.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { afterFirstPaint } from "../../lib/firstPaint.js";
import { notify } from "../../lib/notify.js";
import { putBounded, without } from "./bounded.js";
import { isDevRunRefusal, recipientsUnconfirmed, transport } from "./transport.js";

const DETAILS_KEPT = 30;

// list: null until loaded. details: id → RoutineDetail, the 30 opened last.
// failed: id → "gone" (404) or "error", for a detail that could not be read.
// unconfirmed: id → the 409 recipients_unconfirmed body of its last Resume,
// until the routine leaves paused.
const EMPTY = { list: null, listFailed: false, details: {}, failed: {}, unconfirmed: {} };
let state = EMPTY;
let started = false;
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

export function useRoutines() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// The store as it is now, for a reader outside React (the ⌘K palette).
export const routinesNow = snapshot;

// The routines Home offers (the field, the `/` menu, the intent): those the
// core's intent reader knows, so a one-off, an archived routine or one in
// Recently deleted is not read as one (eos-mod-routines intent.rs).
const NOT_OFFERED = new Set(["transient", "archived", "deleted"]);
export const offeredRoutines = (list) => (list ?? []).filter((r) => !NOT_OFFERED.has(r.state));

// The list with `row` in place of its old self; a routine new to the list
// joins at the end.
function withRow(list, row) {
  if (!list) return list;
  return list.some((r) => r.id === row.id) ? list.map((r) => (r.id === row.id ? row : r)) : [...list, row];
}

function dropRoutine(id) {
  set({ list: state.list?.filter((r) => r.id !== id) ?? null, details: without(state.details, id), failed: { ...state.failed, [id]: "gone" } });
}

// Deleted: out of its detail, and in the list as the core lists it, in
// Recently deleted until it comes back or its 30 days are over.
function markDeleted(id) {
  const row = state.list?.find((r) => r.id === id);
  set({
    list: row ? withRow(state.list, { ...row, state: "deleted" }) : state.list,
    details: without(state.details, id),
    failed: { ...state.failed, [id]: "gone" },
  });
}

export async function refreshRoutines() {
  const r = await transport.get(ROUTES.routines).catch(() => null);
  if (r?.ok && Array.isArray(r.body)) set({ list: r.body, listFailed: false });
  else if (state.list === null) set({ listFailed: true });
}

export function ensureRoutinesLoaded() {
  if (started) return;
  started = true;
  void afterFirstPaint(refreshRoutines);
}

export async function loadRoutine(id) {
  const r = await transport.get(ROUTES.routine(id)).catch(() => null);
  if (r?.ok && r.body?.routine?.id === id) {
    set({
      details: putBounded(state.details, id, r.body, DETAILS_KEPT),
      failed: without(state.failed, id),
      list: withRow(state.list, r.body.routine),
    });
  } else if (r?.status === 404) {
    dropRoutine(id);
  } else if (!state.details[id]) {
    set({ failed: { ...state.failed, [id]: "error" } });
  }
}

// SSE routine:change { routineId, reason, row? } (state/eos/live.js).
export function applyRoutineChange(payload) {
  const id = payload?.routineId;
  if (typeof id !== "string") return;
  if (payload.reason === "deleted") {
    if (state.list?.some((r) => r.id === id) || state.details[id]) markDeleted(id);
    return;
  }
  const row = payload.row;
  if (row?.id !== id) return;
  putRoutineRow(row);
}

// The row in the list and in its detail; the blueprint editor's writes
// answer it too.
export function putRoutineRow(row) {
  const detail = state.details[row.id];
  set({
    list: withRow(state.list, row),
    details: detail ? { ...state.details, [row.id]: { ...detail, routine: row } } : state.details,
    unconfirmed: row.state === "paused" ? state.unconfirmed : without(state.unconfirmed, row.id),
  });
}

// A write the routine page makes: its answer when the core took it. A dev
// run's refusal is said on the screen (the transport notes it), and so is a
// refusal `shown` takes; any other failure is a toast.
async function routineWrite(method, path, body, shown = () => false) {
  const r = await transport.send(method, path, body).catch(() => null);
  if (r?.ok) return r;
  if (!isDevRunRefusal(r) && !shown(r)) notify.error(r?.body?.error ?? "Eos could not do that.", { title: "Routine" });
  return null;
}

const rowOf = (id) => state.details[id]?.routine ?? state.list?.find((r) => r.id === id);

// The routine's row as the store holds it, or undefined.
export const routineRow = (id) => rowOf(id);

// PUT state: active, paused or archived; the core answers the row. Pausing
// shows at once and goes back when the core refuses it (08 §4.2); the other
// states wait for the answer. A Resume refused until recipients are
// confirmed keeps the refusal for the paused band (D53).
export async function setRoutineState(id, next) {
  const before = rowOf(id);
  if (next === "paused" && before) putRoutineRow({ ...before, state: "paused", pausedReason: "user" });
  const r = await routineWrite("PUT", ROUTES.routineState(id), { state: next }, (refused) => {
    const refusal = recipientsUnconfirmed(refused);
    if (refusal) set({ unconfirmed: { ...state.unconfirmed, [id]: refusal } });
    return Boolean(refusal);
  });
  if (r?.body?.id === id) putRoutineRow(r.body);
  else if (!r && next === "paused" && before) putRoutineRow(before);
  return Boolean(r);
}

// To Recently deleted; true when the core took it.
export async function deleteRoutine(id) {
  const r = await routineWrite("DELETE", ROUTES.routine(id));
  if (r) markDeleted(id);
  return Boolean(r);
}

// Back from Recently deleted: the core answers its row, paused when it ran
// before, a draft when it never did; true when it took it.
export async function undeleteRoutine(id) {
  const r = await routineWrite("POST", ROUTES.routineUndelete(id));
  if (r?.body?.id !== id) return false;
  set({ failed: without(state.failed, id) });
  putRoutineRow(r.body);
  return true;
}

// Keep a one-off as a routine (01 G41): the core answers its row, now a
// routine of its own; true when it took it.
export async function keepRoutine(id) {
  const r = await routineWrite("POST", ROUTES.routineKeep(id));
  if (r?.body?.id === id) putRoutineRow(r.body);
  return Boolean(r);
}

// "Start another like this": a draft copy (01 §6). The core answers
// RoutineSaved, the copy's row in `row`; the copy's id, or null.
export async function copyRoutine(id) {
  const r = await routineWrite("POST", ROUTES.routineCopy(id));
  const row = r?.body?.row;
  if (typeof row?.id !== "string") return null;
  putRoutineRow(row);
  return row.id;
}

// The routine as one file (01 §6): its versions and settings, no runs; null
// when the core does not answer it.
export async function exportRoutine(id) {
  const r = await transport.get(ROUTES.routineExport(id)).catch(() => null);
  if (r?.ok && r.body?.format != null) return r.body;
  notify.error(r?.body?.error ?? "Eos could not write this routine to a file.", { title: "Routine" });
  return null;
}

// What a routine file's text holds, read before anything is sent: the file,
// its routine's name and how many versions it carries; null when the text
// is not a routine file.
export function readRoutineFile(text) {
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return null;
  }
  if (!file || typeof file !== "object" || Array.isArray(file)) return null;
  const name = typeof file.routine?.name === "string" ? file.routine.name : null;
  const versions = Array.isArray(file.versions) ? file.versions.length : 0;
  return { file, name, versions };
}

// A read routine file made a draft routine here: nothing in the file sends
// or earns freedom until the user confirms it on this Mac (L14). The draft's
// id, or the core's reason it refused (`error`), said by the caller.
export async function importRoutineFile(file) {
  let refused = null;
  const r = await routineWrite("POST", ROUTES.routinesImport, file, (answer) => {
    refused = answer?.body?.error ?? "Eos could not read this routine file.";
    return true;
  });
  const row = r?.body?.row;
  if (typeof row?.id !== "string") return { error: refused ?? "Eos could not read this routine file." };
  putRoutineRow(row);
  return { id: row.id };
}

// A routine file's text made a draft routine here; the draft's id, or null
// with the reason said.
export async function importRoutine(text) {
  const read = readRoutineFile(text);
  if (!read) {
    notify.error("This is not a routine file.", { title: "Routine" });
    return null;
  }
  const done = await importRoutineFile(read.file);
  if (done.id) return done.id;
  notify.error(done.error, { title: "Routine" });
  return null;
}

// GET candidates: what the run form offers to run on, newest first; empty
// when the core gives none (a dev run refuses them).
export async function loadCandidates(id, q = "") {
  const query = new URLSearchParams({ limit: "20" });
  if (q.trim()) query.set("q", q.trim());
  const r = await transport.get(`${ROUTES.routineCandidates(id)}?${query}`).catch(() => null);
  return r?.ok && Array.isArray(r.body?.items) ? r.body.items : [];
}

export function resyncRoutines() {
  if (started) void refreshRoutines();
  for (const id of Object.keys(state.details)) void loadRoutine(id);
}

export function _resetRoutines() {
  state = EMPTY;
  started = false;
}
