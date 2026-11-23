// homeRunsStore — the runs started from the Home input (or a drop on a disc),
// each shown as a live line under the input until ten seconds after it
// ended (08 G16). A run dropped on a disc may be stopped for its first five
// seconds (D40). Beside them, the one-offs done from Home. In memory only:
// a reload starts with none.

import { useSyncExternalStore } from "react";

export const STOP_FOR_MS = 5000;
export const LINGER_MS = 10_000;

let lines = [];
// The one-offs done from Home ({ routineId, name, runId, kept }), newest
// first; each stays until dismissed (08 G17).
let onces = [];
const subs = new Set();

function set(next) {
  lines = next;
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => lines;
const oncesSnapshot = () => onces;

export function useHomeRuns() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useOnces() {
  return useSyncExternalStore(subscribe, oncesSnapshot, oncesSnapshot);
}

function setOnces(next) {
  onces = next;
  for (const cb of subs) cb();
}

export function addOnce(started) {
  setOnces([{ ...started, kept: false }, ...onces.filter((o) => o.runId !== started.runId)]);
}

export function markOnceKept(runId) {
  setOnces(onces.map((o) => (o.runId === runId ? { ...o, kept: true } : o)));
}

export function dismissOnce(runId) {
  setOnces(onces.filter((o) => o.runId !== runId));
}

// Runs the core started ({ id, routineId }…), newest first. `stoppable`
// marks a start the user did not confirm in words (a drop).
export function addHomeRuns(runs, { now = Date.now(), stoppable = false } = {}) {
  const added = runs.map((r) => ({ runId: r.id, routineId: r.routineId, addedAt: now, stopUntil: stoppable ? now + STOP_FOR_MS : null }));
  set([...added, ...lines.filter((l) => !added.some((a) => a.runId === l.runId))]);
}

export function dropHomeRun(runId) {
  if (lines.some((l) => l.runId === runId)) set(lines.filter((l) => l.runId !== runId));
}

export function _resetHomeRuns() {
  lines = [];
  onces = [];
}
