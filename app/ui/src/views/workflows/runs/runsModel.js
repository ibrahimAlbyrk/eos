// Pure, DOM-free logic for the read-only Runs view: backfilling per-node coloring
// from the persisted step rows, deciding whether a run renders on the canvas or
// falls back to a step list, formatting elapsed time, and live-merging a run-change
// SSE event into the runs list. Kept free of React/DOM so it unit-tests in
// the repo's node test environment, like graphModel.js / runEvents.js.
//
// The per-NODE live coloring during a run is folded by editor/runEvents.js
// (reduceRunEvent); this module covers the run-LIST side and the
// backfill/decision/formatting helpers around it.

import { isGraphDefinition } from "../management/libraryModel.js";

const TERMINAL_RUN_STATUSES = new Set(["passed", "failed", "stopped"]);

export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function isActiveRunStatus(status) {
  return status === "pending" || status === "running";
}

// A run is stoppable only while non-terminal (the one surviving run-write op).
export function canStopRun(run) {
  return Boolean(run) && isActiveRunStatus(run.status);
}

// Step rows → { [nodeId]: status } for the canvas backfill on mount. Later rows for
// the same node win (a re-run / loop re-entry reflects the most recent state).
export function stepsToNodeStates(steps) {
  const out = {};
  for (const s of steps || []) {
    if (!s || typeof s.nodeId !== "string") continue;
    out[s.nodeId] = s.status;
  }
  return out;
}

// Step rows grouped by node, preserving first-seen order — drives the per-node step
// side-list (and the step-list fallback). Each group carries every row for that
// node so a looped node shows each iteration.
export function groupStepsByNode(steps) {
  const order = [];
  const byNode = new Map();
  for (const s of steps || []) {
    if (!s || typeof s.nodeId !== "string") continue;
    if (!byNode.has(s.nodeId)) {
      byNode.set(s.nodeId, { nodeId: s.nodeId, nodeType: s.nodeType, steps: [] });
      order.push(s.nodeId);
    }
    byNode.get(s.nodeId).steps.push(s);
  }
  return order.map((id) => byNode.get(id));
}

// The definition record a run was launched from (matched by name). Inline runs
// (definitionName === null) never match — they have no stored graph to draw.
export function findRunDefinition(records, run) {
  const name = run?.definitionName;
  if (!name) return null;
  return (records || []).find((r) => r?.name === name) || null;
}

// Decide how a run renders: "graph" iff its definition resolves to a v2 graph the
// canvas can lay out; otherwise "steplist" (inline runs + v1 trees fall back to the
// per-node step list — the operator-approved fallback).
export function resolveRunView(run, record) {
  return record && isGraphDefinition(record) ? "graph" : "steplist";
}

// Human elapsed: "45s" / "2m 5s" / "1h 3m". `—` for a missing/invalid duration.
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Elapsed for a run: terminal runs freeze at (updatedAt − startedAt); active runs
// tick against the caller-supplied `nowMs` (the caller owns the clock so this stays
// pure and testable).
export function runDurationMs(run, nowMs) {
  if (!run || typeof run.startedAt !== "number") return null;
  const end = isTerminalRunStatus(run.status)
    ? (typeof run.updatedAt === "number" ? run.updatedAt : run.startedAt)
    : nowMs;
  return Math.max(0, end - run.startedAt);
}

// Elapsed for a single step row: settled steps freeze at endedAt, in-flight tick
// against nowMs.
export function stepDurationMs(step, nowMs) {
  if (!step || typeof step.startedAt !== "number") return null;
  const end = typeof step.endedAt === "number" ? step.endedAt : nowMs;
  return Math.max(0, end - step.startedAt);
}

// Live-merge a workflow:run-change payload into a runs list: flip the matching
// run's status in place. Returns the SAME array reference when nothing matched or
// the status was unchanged, so React can skip the re-render (mirrors runEvents).
export function applyRunChangeToList(runs, change) {
  if (!Array.isArray(runs) || !change || !change.runId) return runs;
  let changed = false;
  const next = runs.map((r) => {
    if (r && r.id === change.runId && r.status !== change.status) {
      changed = true;
      return { ...r, status: change.status };
    }
    return r;
  });
  return changed ? next : runs;
}

// Most-recently-updated first (updatedAt, falling back to startedAt).
export function sortRunsByRecency(runs) {
  return [...(runs || [])].sort(
    (a, b) => (b?.updatedAt ?? b?.startedAt ?? 0) - (a?.updatedAt ?? a?.startedAt ?? 0),
  );
}
