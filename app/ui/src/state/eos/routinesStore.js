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

// The list with `row` in place of its old self; a routine new to the list
// joins at the end.
function withRow(list, row) {
  if (!list) return list;
  return list.some((r) => r.id === row.id) ? list.map((r) => (r.id === row.id ? row : r)) : [...list, row];
}

function dropRoutine(id) {
  set({ list: state.list?.filter((r) => r.id !== id) ?? null, details: without(state.details, id), failed: { ...state.failed, [id]: "gone" } });
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
    if (state.list?.some((r) => r.id === id) || state.details[id]) dropRoutine(id);
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
  if (r) dropRoutine(id);
  return Boolean(r);
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
