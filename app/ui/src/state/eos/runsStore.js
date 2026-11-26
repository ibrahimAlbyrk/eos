// runsStore — each routine's runs, newest first, 50 to a page; the detail of
// each run opened and the result of a finished one shown; how many runs are
// live; and the writes the run view makes. A run:change reads that one run
// again, never a whole page.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { afterFirstPaint } from "../../lib/firstPaint.js";
import { notify } from "../../lib/notify.js";
import { putBounded, without } from "./bounded.js";
import { isDevRunRefusal, transport } from "./transport.js";

const PAGE = 50;
const DETAILS_KEPT = 20;

// pages: routineId → { runs, nextBefore, failed }, null runs until loaded.
// details: runId → RunDetail, the 20 opened last. failed: runId → "gone" or
// "error". results: runId → RunResultBody, for the runs whose details are
// kept. stopping: runId → true while its stop waits for the core's answer.
// active: { count, needsUser } from runs:active or its read, null until one
// came.
const EMPTY = { pages: {}, details: {}, failed: {}, results: {}, stopping: {}, active: null };
let state = EMPTY;
let activeStarted = false;
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
    set({ details: without(state.details, id), results: without(state.results, id), failed: { ...state.failed, [id]: "gone" } });
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

// The result a finished run handed in last, for a run whose detail is kept.
export async function loadRunResult(id) {
  const r = await transport.get(ROUTES.runResult(id)).catch(() => null);
  if (r?.ok && r.body?.runId === id) set({ results: putBounded(state.results, id, r.body, DETAILS_KEPT) });
}

// A write the run view makes: true when the core took it. A dev run's
// refusal is said on the screen (the transport notes it); any other failure
// is a toast.
async function runWrite(path, body) {
  const r = await transport.send("POST", path, body).catch(() => null);
  if (r?.ok) return true;
  if (!isDevRunRefusal(r)) notify.error(r?.body?.error ?? "Eos could not do that.", { title: "Run" });
  return false;
}

// Stop waits for the core's answer (08 §4.2): "Stopping…" until it came.
export async function stopRun(id) {
  if (state.stopping[id]) return;
  set({ stopping: { ...state.stopping, [id]: true } });
  if (await runWrite(ROUTES.runStop(id))) await loadRun(id);
  set({ stopping: without(state.stopping, id) });
}

// Pauses a run at work or at its check; Resume brings its lead back.
export async function pauseRun(id) {
  if (await runWrite(ROUTES.runPause(id))) await loadRun(id);
}

export async function resumeRun(id) {
  if (await runWrite(ROUTES.runResume(id))) await loadRun(id);
}

// The user's words to the run's team; true when they reached it.
export function messageRun(id, text) {
  return runWrite(ROUTES.runMessage(id), { text });
}

// POST /api/runs from the run form; it waits for the core's answer. →
// { runs } when it started, { repeat: existingRunId } when the routine
// handled the same item lately, { devRun: true }, { offline: true }, or
// { error } in words.
export async function startRun(body) {
  const r = await transport.send("POST", ROUTES.runs, body).catch(() => null);
  if (r?.ok && Array.isArray(r.body?.runs)) return { runs: r.body.runs };
  if (r === null) return { offline: true };
  if (r.status === 409 && typeof r.body?.existingRunId === "string") return { repeat: r.body.existingRunId };
  if (isDevRunRefusal(r)) return { devRun: true };
  return { error: r.body?.error ?? "Eos could not start the run." };
}

// POST /api/runs/once: do what the sentence asks, once. → { started:
// { routineId, name, runId } }, or { devRun }, { offline } or { error } in
// words.
export async function startOnce(body) {
  const r = await transport.send("POST", ROUTES.runsOnce, body).catch(() => null);
  if (r?.ok && typeof r.body?.run?.id === "string") return { started: { routineId: r.body.routineId, name: r.body.name, runId: r.body.run.id } };
  if (r === null) return { offline: true };
  if (isDevRunRefusal(r)) return { devRun: true };
  return { error: r.body?.error ?? "Eos could not do it." };
}

// POST /api/runs/estimate → { usd, ms, basis, n }, or null.
export async function estimateRun(body) {
  const r = await transport.send("POST", ROUTES.runsEstimate, body).catch(() => null);
  return r?.ok && typeof r.body?.ms === "number" ? r.body : null;
}

// SSE runs:active { count, needsUser }.
export function applyRunsActive(payload) {
  if (typeof payload?.count !== "number") return;
  set({ active: { count: payload.count, needsUser: payload.needsUser ?? 0 } });
}

// The count before its first event: read once after the first paint.
export async function loadRunsActive() {
  const r = await transport.get(ROUTES.runsActive).catch(() => null);
  if (r?.ok) applyRunsActive(r.body);
}

export function ensureRunsActiveLoaded() {
  if (activeStarted) return;
  activeStarted = true;
  void afterFirstPaint(loadRunsActive);
}

export function resyncRuns() {
  if (activeStarted) void loadRunsActive();
  for (const routineId of Object.keys(state.pages)) void loadRuns(routineId);
  for (const id of Object.keys(state.details)) void loadRun(id);
}

export function _resetRuns() {
  state = EMPTY;
  activeStarted = false;
}
