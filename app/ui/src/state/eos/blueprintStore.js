// blueprintStore — what the blueprint editor reads and writes: each routine's
// draft as its architect leaves it, its versions and the blueprints of the
// versions opened, what the user said to the architect in this window, and
// the one note the editor shows after a write (changed elsewhere, refused,
// a trial needed, an architect's refusal).

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { notify } from "../../lib/notify.js";
import { putBounded, without } from "./bounded.js";
import { loadRoutine, putRoutineRow, routineRow } from "./routinesStore.js";
import { isDevRunRefusal, transport } from "./transport.js";

const BLUEPRINTS_KEPT = 40;
const SAID_KEPT = 50;

// The key of the new routine's screen, which has no routine id yet.
export const NEW = "new";

// drafts: routineId → DraftView, or null when the routine has none.
// versions: routineId → RoutineVersionRow[] oldest first. blueprints:
// versionId → RoutineVersion. said: routineId → the user's words this window.
// notes: routineId (or NEW) → { kind, text, issues? }.
const EMPTY = { drafts: {}, versions: {}, blueprints: {}, said: {}, notes: {} };
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

export function useBlueprints() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function note(key, value) {
  set({ notes: value ? { ...state.notes, [key]: value } : without(state.notes, key) });
}

export const clearNote = (key) => note(key, null);

export async function loadDraft(id) {
  const r = await transport.get(ROUTES.routineDraft(id)).catch(() => null);
  if (r?.ok && typeof r.body?.status === "string") set({ drafts: { ...state.drafts, [id]: r.body } });
  else if (r?.status === 404) set({ drafts: { ...state.drafts, [id]: null } });
}

export async function loadVersions(id) {
  const r = await transport.get(ROUTES.routineVersions(id)).catch(() => null);
  if (r?.ok && Array.isArray(r.body)) set({ versions: { ...state.versions, [id]: r.body } });
}

export async function loadVersion(id, versionId) {
  if (state.blueprints[versionId]) return;
  const r = await transport.get(ROUTES.routineVersion(id, versionId)).catch(() => null);
  if (r?.ok && r.body?.id === versionId) set({ blueprints: putBounded(state.blueprints, versionId, r.body, BLUEPRINTS_KEPT) });
}

// SSE routine:change: a routine whose draft or versions the editor holds
// reads them again.
export function applyBlueprintChange(payload) {
  const id = payload?.routineId;
  if (typeof id !== "string") return;
  if (id in state.drafts) void loadDraft(id);
  if (state.versions[id]) void loadVersions(id);
}

// SSE run:change: a draft's trial runs move on.
export function applyTrialChange(payload) {
  const id = payload?.routineId;
  if (typeof id === "string" && state.drafts[id]) void loadDraft(id);
}

export function resyncBlueprints() {
  for (const id of Object.keys(state.drafts)) void loadDraft(id);
  for (const id of Object.keys(state.versions)) void loadVersions(id);
}

// A write's answer, or null. A dev run's refusal is said on the screen (the
// transport notes it); a status in `handled` is the caller's to show; any
// other failure is a toast.
async function write(method, path, body, handled = []) {
  const r = await transport.send(method, path, body).catch(() => null);
  if (r?.ok || handled.includes(r?.status)) return r;
  if (!isDevRunRefusal(r)) notify.error(r?.body?.error ?? "Eos could not do that.", { title: "Blueprint" });
  return null;
}

const refused = (body) => ({ kind: "refused", text: "Eos could not keep this blueprint.", issues: body?.issues ?? [] });
// The architect routes' 409s by code: only `architects_busy` offers drafts
// to leave; the others are said as a line of their own.
const ARCHITECT_REFUSALS = {
  architects_busy: "Three architects are at work. Leave a draft to make room.",
  newer_format: "A newer version of Eos made this routine. It cannot be changed here.",
};
const architectRefused = (body) => ({
  kind: body?.code === "architects_busy" ? "crowded" : "refusal",
  text: ARCHITECT_REFUSALS[body?.code] ?? body?.error ?? "Eos could not do that.",
});

// A version was written (RoutineSaved): its row, its detail and versions read again.
async function saved(id, body) {
  if (body?.row?.id === id) putRoutineRow(body.row);
  await Promise.all([loadRoutine(id), loadVersions(id)]);
  const warnings = body?.warnings ?? [];
  note(id, warnings.length ? { kind: "warnings", text: "Kept, with something to look at.", issues: warnings } : null);
}

// A hand edit: a new version from `baseVersionId`. 409: someone changed the
// routine since; the editor reads it again and says so.
export async function saveBlueprint(id, baseVersionId, blueprint) {
  const r = await write("PUT", ROUTES.routineBlueprint(id), { baseVersionId, blueprint }, [400, 409]);
  if (!r) return false;
  if (r.status === 409) {
    await Promise.all([loadRoutine(id), loadVersions(id), loadDraft(id)]);
    note(id, { kind: "conflict", text: "Changed elsewhere. This is the routine as it is now." });
    return false;
  }
  if (r.status === 400) return note(id, refused(r.body)), false;
  await saved(id, r.body);
  return true;
}

// "Fill it by hand": a draft routine from a blueprint; its id, or null.
export async function createRoutine(blueprint) {
  const r = await write("POST", ROUTES.routines, { blueprint }, [400]);
  if (!r) return null;
  if (r.status === 400) return note(NEW, refused(r.body)), null;
  const id = r.body?.row?.id;
  if (typeof id !== "string") return null;
  putRoutineRow(r.body.row);
  note(NEW, null);
  return id;
}

function remember(id, text) {
  set({ said: { ...state.said, [id]: [...(state.said[id] ?? []), text].slice(-SAID_KEPT) } });
}

// A new routine from what the user wants, its architect at work; its id,
// or null.
export async function makeRoutine(sentence) {
  const r = await write("POST", ROUTES.routinesArchitect, { sentence }, [409]);
  if (!r) return null;
  if (r.status === 409) return note(NEW, architectRefused(r.body)), null;
  const id = r.body?.row?.id;
  if (typeof id !== "string") return null;
  putRoutineRow(r.body.row);
  note(NEW, null);
  return id;
}

// The routine's draft has an architect to talk to: messages go to it; else
// the words ask for a change, which brings one from the head. A routine
// still being made has no head to change from (the core refuses), so its
// words go to its draft's architect even after the user left the draft,
// which brings that architect back.
const talking = (id, draft) => Boolean(draft) && (draft.status !== "abandoned" || routineRow(id)?.state === "draft");

// The user's words, or a choice answering the architect's question.
export async function sayToArchitect(id, said) {
  const words = said.text ?? said.choice;
  const path = talking(id, state.drafts[id]) ? ROUTES.routineDraftMessage(id) : ROUTES.routineChange(id);
  const body = path === ROUTES.routineChange(id) ? { text: words } : said;
  remember(id, words);
  const r = await write("POST", path, body, [409]);
  if (!r) return false;
  if (r.status === 409) return note(id, architectRefused(r.body)), false;
  if (typeof r.body?.status === "string") set({ drafts: { ...state.drafts, [id]: r.body } });
  note(id, null);
  return true;
}

// Start it, Use this version: the draft becomes the routine's head.
export async function startRoutine(id, withoutTrial = false) {
  const r = await write("POST", ROUTES.routineStart(id), { withoutTrial }, [400, 409]);
  if (!r) return false;
  if (r.status === 400) return note(id, refused(r.body)), false;
  if (r.status === 409) {
    return note(id, { kind: "start", text: r.body?.error ?? "Eos could not start it." }), false;
  }
  if (r.body?.id === id) putRoutineRow(r.body);
  note(id, null);
  await Promise.all([loadRoutine(id), loadVersions(id), loadDraft(id)]);
  return true;
}

// A trial the core refuses names what is missing (a project, a sign-in).
export async function runTrial(id) {
  const r = await write("POST", ROUTES.routineTrial(id), {}, [409]);
  if (!r) return false;
  if (r.status === 409) return note(id, { kind: "start", text: r.body?.error ?? "Eos could not start the trial." }), false;
  note(id, null);
  await loadDraft(id);
  return true;
}

// Discard: the draft is left, its architect stops.
export async function discardDraft(id) {
  const r = await write("DELETE", ROUTES.routineDraft(id));
  if (r && typeof r.body?.status === "string") set({ drafts: { ...state.drafts, [id]: r.body } });
  if (r) note(id, null);
  return Boolean(r);
}

// Restore: a new version with the old one's blueprint.
export async function restoreVersion(id, versionId) {
  const r = await write("POST", ROUTES.routineVersionRestore(id, versionId), undefined, [400, 409]);
  if (!r) return false;
  if (r.status !== 200) return note(id, r.status === 400 ? refused(r.body) : { kind: "start", text: r.body?.error ?? "Eos could not restore it." }), false;
  await saved(id, r.body);
  return true;
}

export function _resetBlueprints() {
  state = EMPTY;
}
