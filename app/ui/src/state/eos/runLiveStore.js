// runLiveStore — what a run's agents are doing now (run:activity), for the runs
// on screen only. The core sends a run's activity only to a tab whose stream
// focus names it, so a run view retains its run while it shows and releases it
// when it goes; the lines go with the last release. Each agent keeps its last
// three lines.

import { useSyncExternalStore } from "react";
import { retainRun } from "../streamFocus.js";

const LINES_KEPT = 3;
const NONE = {};

// held: runId → { count, drop } (drop releases the stream focus).
const held = new Map();
// lines: runId → { workerId → [line…] }, oldest first.
let lines = {};
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

// The lines of one run's agents, by worker id.
export function useRunLines(runId) {
  return useSyncExternalStore(subscribe, snapshot, snapshot)[runId] ?? NONE;
}

export function retain(runId) {
  const known = held.get(runId);
  if (known) known.count += 1;
  else held.set(runId, { count: 1, drop: retainRun(runId) });
}

export function release(runId) {
  const known = held.get(runId);
  if (!known) return;
  known.count -= 1;
  if (known.count > 0) return;
  known.drop();
  held.delete(runId);
  if (lines[runId]) {
    const { [runId]: _, ...rest } = lines;
    set(rest);
  }
}

// SSE run:activity { runId, workerId, agentKey, line, at }; agentKey is null
// for the checker, so lines are kept by worker. A line the agent already
// showed last is not shown twice.
export function applyRunActivity(payload) {
  const { runId, workerId, line } = payload ?? {};
  if (!held.has(runId) || typeof workerId !== "string" || typeof line !== "string") return;
  const run = lines[runId] ?? {};
  const kept = run[workerId] ?? [];
  if (kept[kept.length - 1] === line) return;
  set({ ...lines, [runId]: { ...run, [workerId]: [...kept, line].slice(-LINES_KEPT) } });
}

export function _resetRunLive() {
  for (const { drop } of held.values()) drop();
  held.clear();
  lines = {};
}
