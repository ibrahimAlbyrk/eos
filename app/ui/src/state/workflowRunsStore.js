// Claude Code Workflow runs, per conversation + Workflow call. Two sources:
//   - workflow:progress (SSE): a running run's latest snapshot, then once more
//     with its final status when it ends;
//   - GET /workers/:id/workflow-runs/:callId: hydration on mount / resync, and
//     a finished run's record (phase details, the script's logs).
// The inline card and the side-panel tab read the same entry.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";

// { workerId, callId, tool: the Workflow call (this session only) | null,
//   live: WorkflowRunProgress|null, detail: WorkflowRunDetail|null,
//   fetched: boolean, error: string|null }
const runs = new Map();
const listeners = new Set();
const inflight = new Map();
let version = 0;

const keyOf = (workerId, callId) => `${workerId}\n${callId}`;

function update(workerId, callId, patch) {
  const key = keyOf(workerId, callId);
  const cur = runs.get(key) ?? { workerId, callId, tool: null, live: null, detail: null, fetched: false, error: null };
  runs.set(key, { ...cur, ...patch });
  version++;
  for (const l of listeners) l();
}

// The inline card hands over the call itself, so the side-panel tab can read
// its script's plan (phase titles and details) too.
export function noteWorkflowCall(workerId, callId, tool) {
  if (runs.get(keyOf(workerId, callId))?.tool !== tool) update(workerId, callId, { tool });
}

const isRunning = (r) => (r.live?.status ?? r.detail?.status) === "running";

// Runs still working in a conversation, as far as this window has seen them.
export function runningWorkflowCount(workerId) {
  let n = 0;
  for (const r of runs.values()) if (r.workerId === workerId && isRunning(r)) n++;
  return n;
}

export function applyWorkflowProgress(p) {
  if (!p?.workerId || !p?.callId) return;
  update(p.workerId, p.callId, { live: p });
  // The end carries no record yet: fetch the details only the daemon has.
  if (p.status !== "running") void fetchWorkflowRun(p.workerId, p.callId, { force: true });
}

export function fetchWorkflowRun(workerId, callId, { force = false } = {}) {
  const key = keyOf(workerId, callId);
  if (inflight.has(key)) return inflight.get(key);
  if (!force && runs.get(key)?.fetched) return Promise.resolve();
  const pending = api.getWorkflowRun(workerId, callId)
    .then((detail) => update(workerId, callId, { detail, fetched: true, error: null }))
    .catch((e) => update(workerId, callId, { fetched: true, error: e instanceof Error ? e.message : String(e) }))
    .finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

// The stream lost events (daemon restart, a long gap): refetch every run that
// was still running when it went quiet.
export function resyncWorkflowRuns() {
  for (const r of runs.values()) {
    if (r.fetched && isRunning(r)) void fetchWorkflowRun(r.workerId, r.callId, { force: true });
  }
}

export function getWorkflowRun(workerId, callId) {
  return runs.get(keyOf(workerId, callId)) ?? null;
}

export async function stopWorkflowRun(workerId, callId) {
  const r = await api.stopWorkflowRun(workerId, callId);
  if (!r.ok) throw new Error(r.body?.error ?? `stop failed (${r.status})`);
}

function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useWorkflowRun(workerId, callId) {
  const get = () => (workerId && callId ? getWorkflowRun(workerId, callId) : null);
  return useSyncExternalStore(subscribe, get, get);
}

// Re-render on any run's change (the side panel's tab labels).
export function useWorkflowRunsVersion() {
  const get = () => version;
  return useSyncExternalStore(subscribe, get, get);
}

export function _reset() {
  runs.clear();
  inflight.clear();
  listeners.clear();
  version = 0;
}
