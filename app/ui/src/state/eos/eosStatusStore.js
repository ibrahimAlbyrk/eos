// eosStatusStore — whether Eos mode shows: the core must serve routines. The
// routine list (GET /api/routines) is the probe, asked once after the first
// paint. Until it answers with success — unanswered, or anything else (404
// from a core without routines, 503 feature_failed, a refusal) or nothing at
// all — Eos stays hidden and the app is what it is without Eos.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { afterFirstPaint } from "../../lib/firstPaint.js";
import { transport } from "./transport.js";

let served = false;
let shown = false;
let started = false;
const subs = new Set();

function update() {
  const next = served;
  if (next === shown) return;
  shown = next;
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function isEosShown() {
  return shown;
}

export function useEosShown() {
  return useSyncExternalStore(subscribe, isEosShown, isEosShown);
}

export async function probeEosStatus() {
  const r = await transport.get(ROUTES.routines).catch(() => null);
  served = r?.ok === true;
  update();
}

export function ensureEosStatusLoaded() {
  if (started) return;
  started = true;
  void afterFirstPaint(probeEosStatus);
}
