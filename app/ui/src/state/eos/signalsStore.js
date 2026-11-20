// signalsStore — what starts each opened routine's runs (its schedules,
// sources and open batch, RoutineTriggerStatus) and the signals routed to it,
// by decision, and the blueprint editor's previews. A signals:change reads again what it names: the routine's
// status and lists, or every one held when it names no routine.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { notify } from "../../lib/notify.js";
import { putBounded } from "./bounded.js";
import { isDevRunRefusal, transport } from "./transport.js";

// status: routine id → RoutineTriggerStatus, "gone" when the core has none
// (404), or "error" when it could not be read. lists: listKey → { rows } or
// { failed: true }. replays: signal id → "dev-run" or the SignalDecision a
// replay answered. filters: routine id → the decision its list shows ("" for
// all). previews: preview key → the core's answer, the 30 asked last.
const EMPTY = { status: {}, lists: {}, replays: {}, filters: {}, previews: {} };
const PREVIEWS_KEPT = 30;
let state = EMPTY;
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

export function useSignals() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export const listKey = (routineId, decision) => `${routineId}|${decision ?? ""}`;

const routineOfKey = (key) => key.slice(0, key.lastIndexOf("|"));

export async function loadTriggerStatus(routineId) {
  const r = await transport.get(ROUTES.signalsRoutine(routineId)).catch(() => null);
  if (r?.ok && r.body?.routineId === routineId) set({ status: { ...state.status, [routineId]: r.body } });
  else if (r?.status === 404) set({ status: { ...state.status, [routineId]: "gone" } });
  else if (!state.status[routineId]) set({ status: { ...state.status, [routineId]: "error" } });
}

// GET /api/signals?routine=&decision=: the newest page, each row with its
// decisions.
export async function loadSignals(routineId, decision) {
  const query = new URLSearchParams({ routine: routineId });
  if (decision) query.set("decision", decision);
  const r = await transport.get(`${ROUTES.signals}?${query}`).catch(() => null);
  const key = listKey(routineId, decision);
  if (r?.ok && Array.isArray(r.body)) set({ lists: { ...state.lists, [key]: { rows: r.body } } });
  else if (!state.lists[key]?.rows) set({ lists: { ...state.lists, [key]: { failed: true } } });
}

// Shows the routine's signals decided so, read again.
export function setSignalFilter(routineId, decision) {
  set({ filters: { ...state.filters, [routineId]: decision } });
  return loadSignals(routineId, decision || undefined);
}

// POST replay: these signals of the routine decided again past its Which.
// Each signal keeps what came of it: its new decision, or that a dev run
// refused it; any other refusal is a toast. True when the core took it.
export async function replaySignals(routineId, signalIds) {
  const r = await transport.send("POST", ROUTES.signalsReplay, { routineId, signalIds }).catch(() => null);
  if (r?.ok && Array.isArray(r.body)) {
    // The answer names no signal: it holds one decision per signal, by id.
    const replays = { ...state.replays };
    [...new Set(signalIds)].sort((a, b) => a - b).forEach((id, n) => { if (r.body[n]) replays[id] = r.body[n]; });
    set({ replays });
    return true;
  }
  if (isDevRunRefusal(r)) set({ replays: { ...state.replays, ...Object.fromEntries(signalIds.map((id) => [id, "dev-run"])) } });
  else notify.error(r?.body?.error ?? "Eos could not do that.", { title: "Signals" });
  return false;
}

// The editor's previews, kept by what they asked; a preview the core does
// not answer keeps nothing.
async function preview(key, path, body) {
  const r = await transport.send("POST", path, body).catch(() => null);
  if (r?.ok) set({ previews: putBounded(state.previews, key, r.body, PREVIEWS_KEPT) });
}

export const scheduleKey = (schedule, count) => `schedule:${count}:${JSON.stringify(schedule)}`;

// The next `count` times a schedule fires (SchedulePreviewResponse).
export const loadSchedulePreview = (schedule, count) => preview(scheduleKey(schedule, count), ROUTES.signalsSchedulePreview, { schedule, count });

export const whichKey = (routineId, which, limit) => `which:${routineId}:${limit}:${JSON.stringify(which)}`;

// A Which tried on the routine's latest signals (WhichPreviewResponse).
export const loadWhichPreview = (routineId, which, limit) => preview(whichKey(routineId, which, limit), ROUTES.signalsWhichPreview, { routineId, which, limit });

// SSE signals:change { routineId?, sourceId?, what } (state/eos/live.js).
export function applySignalsChange(payload) {
  const id = typeof payload?.routineId === "string" ? payload.routineId : null;
  for (const routineId of Object.keys(state.status)) if (!id || routineId === id) void loadTriggerStatus(routineId);
  for (const key of Object.keys(state.lists)) {
    const routineId = routineOfKey(key);
    if (!id || routineId === id) void loadSignals(routineId, key.slice(routineId.length + 1) || undefined);
  }
}

export function resyncSignals() {
  applySignalsChange({});
}

export function _resetSignals() {
  state = EMPTY;
}
