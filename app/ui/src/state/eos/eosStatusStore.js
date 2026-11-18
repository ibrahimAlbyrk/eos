// eosStatusStore — whether Eos mode shows. The core must serve routines: the
// routine list (GET /api/routines) is the probe, asked once after the first
// paint. Until it answers, and when it answers anything but success (404 from a
// core without routines, 503 feature_failed, a refusal) or nothing at all, Eos
// stays hidden and the app is what it is without Eos.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { afterFirstPaint } from "../../lib/firstPaint.js";
import { transport } from "./transport.js";

let shown = false;
let started = false;
const subs = new Set();

function set(next) {
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
  set(r?.ok === true);
}

export function ensureEosStatusLoaded() {
  if (started) return;
  started = true;
  void afterFirstPaint(probeEosStatus);
}
