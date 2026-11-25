// freedomStore — a routine's Freedom as the user confirmed it, with its
// streak and offer (03 §4.6): GET /api/routines/:id/freedom, read again when
// `inbox:freedom` names the routine.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { transport } from "./transport.js";

// byRoutine: id → FreedomView { routineId, rung, grants, streak, offer, offerItemId? }.
const EMPTY = { byRoutine: {} };
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

export function useFreedom() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export async function loadFreedom(routineId) {
  const r = await transport.get(ROUTES.routineFreedom(routineId)).catch(() => null);
  if (r?.ok && typeof r.body?.streak === "number") set({ byRoutine: { ...state.byRoutine, [routineId]: r.body } });
}

// `inbox:freedom` { routineId, rung, streak, offer }: only a routine already read is read again.
export function applyFreedomChange(payload) {
  if (payload?.routineId && state.byRoutine[payload.routineId]) void loadFreedom(payload.routineId);
}

export function _resetFreedom() {
  state = EMPTY;
}
