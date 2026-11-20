// haltStore — whether Eos is stopped on this Mac (03 G10): GET /api/eos/halt
// once, then inbox:halt as it switches. Resume switches it off; what was
// stopped then waits in Needs you.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { notify } from "../../lib/notify.js";
import { transport } from "./transport.js";

// halt: HaltState { on, since? }, null until read. resumed: the user resumed
// here and has not put the note away.
const EMPTY = { halt: null, resumed: false };
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

export function useHalt() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export async function loadHalt() {
  const r = await transport.get(ROUTES.eosHalt).catch(() => null);
  if (r?.ok && typeof r.body?.on === "boolean") applyHalt(r.body);
}

export function ensureHaltLoaded() {
  if (started) return;
  started = true;
  void loadHalt();
}

// SSE inbox:halt { on, since? } (state/eos/live.js), and each answer.
export function applyHalt(payload) {
  if (typeof payload?.on !== "boolean") return;
  set({ halt: payload, resumed: payload.on ? false : state.resumed });
}

// POST resume: true once the core switched it off.
export async function resumeEos() {
  const r = await transport.send("POST", ROUTES.eosResume, {}).catch(() => null);
  if (r?.ok && r.body?.on === false) {
    set({ halt: r.body, resumed: true });
    return true;
  }
  notify.error(r?.body?.error ?? "Eos could not do that.", { title: "Eos" });
  return false;
}

export function dismissResumed() {
  set({ resumed: false });
}

export function resyncHalt() {
  if (started) void loadHalt();
}

export function _resetHalt() {
  state = EMPTY;
  started = false;
}
