// surfacesStore — the routines' Views that wait in Needs you (05): each View
// surface placed there with its newest issue, and pressing one of its
// buttons through the direct action route. The core fills every argument
// from the stored issue; the dashboard sends only which button, what the
// user typed or picked, and its own id for the press.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { isDevRunRefusal, transport } from "./transport.js";

// cards: null until loaded, then [{ surface, issue, body }] newest first.
const EMPTY = { cards: null, failed: false };
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

export function ensureSurfacesLoaded() {
  if (started) return;
  started = true;
  void refreshSurfaces();
}

// surfaces:change and surfaces:issue: read the cards again once loaded.
export function applySurfacesChange() {
  if (started) void refreshSurfaces();
}

export const resyncSurfaces = applySurfacesChange;

let presses = 0;
export const pressId = () => `dash-${Date.now().toString(36)}-${(presses += 1)}`;

// One press of `actionId` on `issueId`'s View: the core's answer
// { status: done | confirm | held | refused, … }, or refused with the reason
// when the core turned the request away.
export async function runSurfaceAction({ issueId, actionId, state: input, clientId, confirm, typed }) {
  const body = {
    issueId, actionId, clientId,
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
