// runnersStore — which of the user's Macs runs each routine (02 §3 F.30–34):
// GET /api/runners, read again after a move. Nothing moves by itself: Move
// here is the user's (POST /api/runners/claim).

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { transport } from "./transport.js";

// runners: RunnerView { deviceId, devices: [{ deviceId, name, seenAt, awaySince?, routines }], confirmedAt? },
// null until read.
const EMPTY = { runners: null };
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

export function useRunners() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export async function loadRunners() {
  const r = await transport.get(ROUTES.runners).catch(() => null);
  if (r?.ok && Array.isArray(r.body?.devices)) set({ runners: r.body });
}

// The other Mac that holds the routine, or null when this one does or none is known.
export function holderOf(runners, routineId) {
  return runners?.devices?.find((device) => device.routines?.includes(routineId)) ?? null;
}

// Move here → { moved: true } once this Mac holds it, { holder } when another Mac
// claimed it first, or { error } in the core's words.
export async function moveHere(routineId) {
  const r = await transport.send("POST", ROUTES.runnersClaim, { routineId }).catch(() => null);
  if (!r?.ok) return { error: r?.body?.error ?? "Eos could not move it." };
  await loadRunners();
  return r.body?.claimed ? { moved: true } : { holder: r.body?.holder };
}

export function _resetRunners() {
  state = EMPTY;
}
