// capabilitiesStore — the capabilities Eos has (eos:/capabilities) and the detail
// of each one opened. The list loads once after the first paint; a
// capabilities:change then refetches only the capability it names (its detail
// carries its row), never the whole list. Writes wait for the core's answer.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { afterFirstPaint } from "../../lib/firstPaint.js";
import { notify } from "../../lib/notify.js";
import { isDevRunRefusal, transport } from "./transport.js";

// CapabilityRow's fields; CapabilityDetail is the row and what it is made of.
const ROW_FIELDS = ["id", "name", "summary", "origin", "state", "stateCode", "version", "works", "actionCount", "usedBy", "accountLabel"];

// list: null until loaded. details: id → CapabilityDetail. failed: id → "gone"
// (404) or "error", for a detail that could not be read. devRun: a write was
// refused because this is a dev run.
let state = { list: null, listFailed: false, details: {}, failed: {}, devRun: false };
let started = false;
const asked = new Map(); // id → the number of its latest detail request
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

export function useCapabilities() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const pick = (obj, keep) => Object.fromEntries(Object.entries(obj).filter(([k]) => keep(k)));

export const rowOf = (detail) => pick(detail, (k) => ROW_FIELDS.includes(k));

function without(map, id) {
  const { [id]: _, ...rest } = map;
  return rest;
}

// The list with `row` in place of its old self; a capability new to the list
// joins at the end.
function withRow(list, row) {
  if (!list) return list;
  return list.some((r) => r.id === row.id) ? list.map((r) => (r.id === row.id ? row : r)) : [...list, row];
}

function putRow(row) {
  const detail = state.details[row.id];
  set({
    list: withRow(state.list, row),
    details: detail ? { ...state.details, [row.id]: { ...pick(detail, (k) => !ROW_FIELDS.includes(k)), ...row } } : state.details,
  });
}

function dropCapability(id) {
  set({ list: state.list?.filter((r) => r.id !== id) ?? null, details: without(state.details, id), failed: { ...state.failed, [id]: "gone" } });
}

export async function refreshCapabilities() {
  const r = await transport.get(ROUTES.capabilities).catch(() => null);
  if (r?.ok && Array.isArray(r.body)) set({ list: r.body, listFailed: false });
  else if (state.list === null) set({ listFailed: true });
}

export function ensureCapabilitiesLoaded() {
  if (started) return;
  started = true;
  void afterFirstPaint(refreshCapabilities);
}

// Reads one capability; its row in the list follows. Only the latest request
// for an id lands, so answers that cross on the way cannot go back in time.
export async function loadCapability(id) {
  const n = (asked.get(id) ?? 0) + 1;
  asked.set(id, n);
  const r = await transport.get(ROUTES.capability(id)).catch(() => null);
  if (asked.get(id) !== n) return;
  if (r?.ok && r.body?.id === id) {
    set({ details: { ...state.details, [id]: r.body }, failed: without(state.failed, id), list: withRow(state.list, rowOf(r.body)) });
  } else if (r?.status === 404) {
    dropCapability(id);
  } else if (!state.details[id]) {
    set({ failed: { ...state.failed, [id]: "error" } });
  }
}

// SSE capabilities:change { id, state, stateCode?, version? } (state/eos/live.js):
// the new state shows at once, then the capability is read again.
export function applyCapabilitiesChange(payload) {
  const id = payload?.id;
  if (typeof id !== "string") return;
  const known = state.list?.find((r) => r.id === id) ?? (state.details[id] ? rowOf(state.details[id]) : null);
  // Nothing loaded holds it: the first load reads it as it is.
  if (!known && state.list === null) return;
  if (known) putRow({ ...known, state: payload.state, stateCode: payload.stateCode, version: payload.version });
  void loadCapability(id);
}

export function resyncCapabilities() {
  if (started) void refreshCapabilities();
  for (const id of Object.keys(state.details)) void loadCapability(id);
}

// A write's answer body, or null when it was refused or failed. A dev run's
// refusal is shown on the screen; any other failure is a toast.
async function write(method, path, body) {
  const r = await transport.send(method, path, body).catch(() => null);
  if (r?.ok) return r.body ?? {};
  if (isDevRunRefusal(r)) set({ devRun: true });
  else notify.error(r?.body?.error ?? "Eos isn't reachable.", { title: "Capabilities" });
  return null;
}

export async function checkCapability(id) {
  const row = await write("POST", ROUTES.capabilityCheck(id));
  if (row) putRow(row);
}

export async function setCapabilityEnabled(id, enabled) {
  const row = await write("POST", enabled ? ROUTES.capabilityEnable(id) : ROUTES.capabilityDisable(id), {});
  if (row) putRow(row);
}

// Installs here a capability that arrived from another Mac: it checks its secrets on this one.
export async function installCapabilityHere(id) {
  const row = await write("POST", ROUTES.capabilityInstallHere(id), {});
  if (row) putRow(row);
}

export async function rollbackCapability(id, version) {
  const row = await write("POST", ROUTES.capabilityRollback(id), { version });
  if (row) putRow(row);
}

// Asks the Forge to build the broken capability again → the run's id, once it started.
export async function repairCapability(id, need) {
  const started = await write("POST", ROUTES.forge, { need, capabilityId: id });
  return started?.runId ?? null;
}

// Opens the app's own secret prompt: the value is typed there, never on this page.
// The core answers only whether it kept one.
export async function enterSecret(id, name) {
  const answer = await write("POST", ROUTES.capabilitySecret(id, name), {});
  if (answer?.stored) await loadCapability(id);
}

export async function forgetSecret(id, name) {
  if (await write("DELETE", ROUTES.capabilitySecret(id, name))) await loadCapability(id);
}

// Moves the capability to the trash → true once the core has.
export async function removeCapability(id) {
  if (!(await write("DELETE", ROUTES.capability(id)))) return false;
  dropCapability(id);
  return true;
}

export function _resetCapabilities() {
  state = { list: null, listFailed: false, details: {}, failed: {}, devRun: false };
  started = false;
  asked.clear();
}
