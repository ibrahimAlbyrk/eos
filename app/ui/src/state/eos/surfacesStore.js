// surfacesStore — the routines' Views (05): each View surface placed in
// Needs you with its newest issue, each routine's View for its page, and
// pressing one of its buttons through the direct action route. The core fills every argument
// from the stored issue; the dashboard sends only which button, what the
// user typed or picked, and its own id for the press.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { isDevRunRefusal, transport } from "./transport.js";

// cards: null until loaded, then [{ surface, issue, body }] newest first.
// byRoutine: routine id → its View's card, or null when it has none to show.
// byIssue: issue id → the card of a View a Needs-you item shows, or null
// when it cannot be read.
const EMPTY = { cards: null, failed: false, byRoutine: {}, byIssue: {} };
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

export function useSurfaces() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// How far back the newest real issue is looked for: trials and issues not
// ready yet come first in the list but are never the card.
const ISSUES_LOOKED_AT = 20;

async function newestIssue(surface) {
  const list = await transport.get(`${ROUTES.surfaceIssues(surface.id)}?limit=${ISSUES_LOOKED_AT}`);
  const row = list.ok ? list.body?.issues?.find((i) => i.status === "ready" && !i.trial) : null;
  if (!row) return null;
  const one = await transport.get(ROUTES.surfaceIssue(surface.id, row.id));
  return one.ok && one.body?.body?.view ? { surface, issue: one.body.issue, body: one.body.body } : null;
}

export async function refreshSurfaces() {
  const r = await transport.get(`${ROUTES.surfaces}?place=needs_you`);
  if (!r.ok) {
    set({ failed: state.cards === null });
    return;
  }
  const views = (r.body?.surfaces ?? []).filter((s) => s.level === "view" && !s.archivedAt);
  const cards = (await Promise.all(views.map(newestIssue))).filter(Boolean);
  cards.sort((a, b) => b.issue.createdAt - a.issue.createdAt);
  set({ cards, failed: false });
}

// The routine's View with its newest issue, for the routine's page.
export async function loadRoutineView(routineId) {
  const r = await transport.get(`${ROUTES.surfaces}?routine=${encodeURIComponent(routineId)}`);
  const view = r.ok ? (r.body?.surfaces ?? []).find((s) => s.level === "view" && !s.archivedAt) : null;
  const card = view ? await newestIssue(view) : null;
  set({ byRoutine: { ...state.byRoutine, [routineId]: card } });
}

// The View or page issue a Needs-you item shows ({ surfaceId, issueId } of
// the item).
export async function loadItemView({ surfaceId, issueId }) {
  if (issueId in state.byIssue) return;
  const one = await transport.get(ROUTES.surfaceIssue(surfaceId, issueId));
  const shown = one.ok && (one.body?.body?.view || one.body?.issue?.kind === "page");
  const card = shown ? { issue: one.body.issue, body: one.body.body } : null;
  set({ byIssue: { ...state.byIssue, [issueId]: card } });
}

export function ensureSurfacesLoaded() {
  if (started) return;
  started = true;
  void refreshSurfaces();
}

// surfaces:change and surfaces:issue: read the cards and the routines'
// Views again once loaded.
export function applySurfacesChange() {
  if (started) void refreshSurfaces();
  for (const routineId of Object.keys(state.byRoutine)) void loadRoutineView(routineId);
}

export const resyncSurfaces = applySurfacesChange;

let presses = 0;
export const pressId = () => `dash-${Date.now().toString(36)}-${(presses += 1)}`;

// Which row of the View's data a button inside a list was pressed on, as the
// core picks it: the row's id when it has one, else its place in the first
// list of the data that holds it. Nothing of the row itself is sent.
export function pressedRow(data, item) {
  if (item == null) return {};
  if (typeof item === "string" || typeof item === "number") return { itemId: String(item) };
  const wanted = JSON.stringify(item);
  const find = (node) => {
    if (Array.isArray(node)) {
      const at = node.findIndex((row) => JSON.stringify(row) === wanted);
      if (at >= 0) return at;
      for (const row of node) {
        const inner = find(row);
        if (inner != null) return inner;
      }
    } else if (node && typeof node === "object") {
      for (const value of Object.values(node)) {
        const inner = find(value);
        if (inner != null) return inner;
      }
    }
    return null;
  };
  const index = find(data);
  return index == null ? {} : { index };
}

// One press of `actionId` on `issueId`'s View, or of a Page's `button` (the
// part it sits in): the core's answer
// { status: done | confirm | held | refused, … }, or refused with the reason
// when the core turned the request away.
// One tools/call of an App in use, relayed to the core, which holds it to the
// App's manifest. Resolves to the call's result; rejects with the reason the
// App reads as its JSON-RPC error.
export async function callSurfaceApp({ surfaceId, version, name, arguments: args, clientId, confirm, typed }) {
  const body = {
    version, name, arguments: args ?? {},
    ...(clientId ? { clientId } : {}),
    ...(confirm ? { confirm } : {}),
    ...(typed ? { typed } : {}),
  };
  const r = await transport.send("POST", ROUTES.surfaceAppCall(surfaceId), body);
  if (r.ok) return r.body?.result ?? null;
  if (isDevRunRefusal(r)) throw new Error("This is a dev run: an App calls nothing from here.");
  throw new Error(r.body?.error ?? `The App's call failed (${r.status}).`);
}

// Hands an App in use to the Forge to become an Extension → the Forge run's
// id, or the reason it did not start.
export async function promoteApp(surfaceId, title) {
  const need = `Make the App ${title} an Extension`;
  const r = await transport.send("POST", ROUTES.forge, { need, fromSurface: surfaceId });
  if (r.ok && r.body?.runId) return { runId: r.body.runId };
  if (isDevRunRefusal(r)) return { error: "This is a dev run: the Forge starts nothing from here." };
  return { error: r.body?.error ?? `The Forge did not start (${r.status}).` };
}

export async function runSurfaceAction({ issueId, actionId, button, state: input, clientId, confirm, typed, itemId, index }) {
  const body = {
    issueId, clientId,
    ...(actionId != null ? { actionId } : {}),
    ...(button != null ? { button } : {}),
    ...(itemId != null ? { itemId } : {}),
    ...(index != null ? { index } : {}),
    ...(input && Object.keys(input).length ? { state: input } : {}),
    ...(confirm ? { confirm } : {}),
    ...(typed ? { typed } : {}),
  };
  const r = await transport.send("POST", ROUTES.actionsRun, body);
  if (r.ok && r.body?.status) return r.body;
  if (isDevRunRefusal(r)) return { status: "refused", reason: "This is a dev run: nothing runs from here." };
  return { status: "refused", reason: r.body?.error ?? `The action could not run (${r.status}).` };
}

export function _resetSurfaces() {
  state = EMPTY;
  started = false;
}
