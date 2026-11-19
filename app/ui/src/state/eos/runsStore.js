// runsStore — each routine's runs, newest first, 50 to a page; the detail of
// each run opened; and how many runs are live. A run:change reads that one
// run again, never a whole page.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { afterFirstPaint } from "../../lib/firstPaint.js";
import { putBounded, without } from "./bounded.js";
import { transport } from "./transport.js";

const PAGE = 50;
const DETAILS_KEPT = 20;

// pages: routineId → { runs, nextBefore, failed }, null runs until loaded.
// details: runId → RunDetail, the 20 opened last. failed: runId → "gone" or
// "error". active: { count, needsUser } from runs:active, null until one came.
const EMPTY = { pages: {}, details: {}, failed: {}, active: null };
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

export function useRuns() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const pagePath = (routineId, before) => {
  const query = new URLSearchParams({ routineId, limit: String(PAGE) });
  if (before != null) query.set("before", String(before));
  return `${ROUTES.runs}?${query}`;
};

function putPage(routineId, page) {
  set({ pages: { ...state.pages, [routineId]: page } });
}

async function readPage(routineId, before) {
  const r = await transport.get(pagePath(routineId, before)).catch(() => null);
  return r?.ok && Array.isArray(r.body?.runs) ? r.body : null;
}

// The first page of a routine's runs, read again whenever it is asked.
export async function loadRuns(routineId) {
  const body = await readPage(routineId);
  const known = state.pages[routineId];
  if (body) putPage(routineId, { runs: body.runs, nextBefore: body.nextBefore ?? null, failed: false });
  else putPage(routineId, { runs: known?.runs ?? null, nextBefore: known?.nextBefore ?? null, failed: true });
}

// The first page once, after the first paint; run:change keeps it after that.
export function ensureRunsLoaded(routineId) {
  if (state.pages[routineId]) return;
  putPage(routineId, { runs: null, nextBefore: null, failed: false });
  void afterFirstPaint(() => loadRuns(routineId));
}

export async function loadMoreRuns(routineId) {
  const page = state.pages[routineId];
  if (page?.nextBefore == null) return;
  const body = await readPage(routineId, page.nextBefore);
  const now = state.pages[routineId];
  if (!body) return putPage(routineId, { ...now, failed: true });
  const seen = new Set(now.runs.map((r) => r.id));
  putPage(routineId, { runs: [...now.runs, ...body.runs.filter((r) => !seen.has(r.id))], nextBefore: body.nextBefore ?? null, failed: false });
}

// A run's row in its routine's first page: in place, or first when it is new.
function withRun(run) {
  const page = state.pages[run.routineId];
  if (!page?.runs) return state.pages;
  const runs = page.runs.some((r) => r.id === run.id) ? page.runs.map((r) => (r.id === run.id ? run : r)) : [run, ...page.runs];
  return { ...state.pages, [run.routineId]: { ...page, runs } };
}

// Reads one run; its row in its routine's page follows. `keep`: the detail
// is kept too (a run opened), not only the row.
export async function loadRun(id, { keep = true } = {}) {
  const r = await transport.get(ROUTES.run(id)).catch(() => null);
  if (r?.ok && r.body?.run?.id === id) {
    const details = keep || state.details[id] ? putBounded(state.details, id, r.body, DETAILS_KEPT) : state.details;
    set({ details, failed: without(state.failed, id), pages: withRun(r.body.run) });
  } else if (r?.status === 404) {
    set({ details: without(state.details, id), failed: { ...state.failed, [id]: "gone" } });
  } else if (keep && !state.details[id]) {
    set({ failed: { ...state.failed, [id]: "error" } });
  }
}

// SSE run:change { runId, routineId, state, station?, reason?, needsUser? }:
// read only when a loaded page or detail holds it, or its routine's page would.
export function applyRunChange(payload) {
  const id = payload?.runId;
  if (typeof id !== "string") return;
  if (state.details[id] || state.pages[payload.routineId]?.runs) void loadRun(id, { keep: Boolean(state.details[id]) });
}

// SSE runs:active { count, needsUser }.
export function applyRunsActive(payload) {
  if (typeof payload?.count !== "number") return;
  set({ active: { count: payload.count, needsUser: payload.needsUser ?? 0 } });
}

export function resyncRuns() {
  for (const routineId of Object.keys(state.pages)) void loadRuns(routineId);
  for (const id of Object.keys(state.details)) void loadRun(id);
}

export function _resetRuns() {
  state = EMPTY;
}
