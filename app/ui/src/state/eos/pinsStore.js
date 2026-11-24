// pinsStore — the surfaces pinned to Home (05 SF-29, 08 §4.11): their ids in
// slot order and the tiles drawn from them. Home holds three; pinning a
// fourth is refused by the core (409), and the screen offers to replace one.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { isDevRunRefusal, transport } from "./transport.js";

export const PIN_SLOTS = 3;

// ids: null until read. tiles: null until read.
const EMPTY = { ids: null, tiles: null, failed: false };
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

export function usePins() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export async function refreshPins() {
  const [pins, tiles] = await Promise.all([transport.get(ROUTES.surfacePins), transport.get(ROUTES.surfaceTiles)]);
  set({
    ids: pins.ok ? pins.body?.surfaceIds ?? [] : state.ids ?? [],
    tiles: tiles.ok ? tiles.body?.tiles ?? [] : state.tiles ?? [],
    failed: !tiles.ok && state.tiles === null,
  });
}

export function ensurePinsLoaded() {
  if (started) return;
  started = true;
  void refreshPins();
}

// Sets the pins to `ids`; the change shows at once (a pin is the user's own
// to make) and is put back when the core refuses it.
export async function setPins(ids) {
  const before = state.ids;
  set({ ids });
  const r = await transport.send("PUT", ROUTES.surfacePins, { surfaceIds: ids });
  if (r.ok) {
    await refreshPins();
    return { ok: true };
  }
  set({ ids: before });
  if (r.status === 409) return { ok: false, full: true };
  return { ok: false, error: isDevRunRefusal(r) ? "This is a dev run." : r.body?.error ?? `Pinning did not work (${r.status}).` };
}

export const pin = (id) => setPins([...(state.ids ?? []).filter((x) => x !== id), id]);
export const unpin = (id) => setPins((state.ids ?? []).filter((x) => x !== id));
// The fourth pin takes `out`'s place.
export const replacePin = (out, id) => setPins((state.ids ?? []).map((x) => (x === out ? id : x)));

// surfaces:pins, and a change of a pinned surface or its issue.
export function applyPinsChange() {
  if (started) void refreshPins();
}

export function applyPinnedSurfaceChange(payload) {
  if (started && state.ids?.includes(payload?.surfaceId)) void refreshPins();
}

export const resyncPins = applyPinsChange;

export function _resetPins() {
  state = EMPTY;
  started = false;
}
