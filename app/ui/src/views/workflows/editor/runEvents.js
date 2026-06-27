// Pure reducer that turns the daemon's SSE `change` events into per-node run state
// for live highlighting. The SseBroadcaster wraps every bus topic as
// `event: change` with data `{ reason, ts, payload }`; the workflow topics are:
//   workflow:run-change   payload { runId, status }
//   workflow:step-change  payload { runId, nodeId, status, workerId }
// (EventBusProgressSink). We track only events for the run we launched.

export function createRunState(runId = null) {
  return { runId, runStatus: runId ? "pending" : null, nodeStates: {} };
}

// Parse one SSE `change` payload string into { reason, payload }, or null if it
// isn't valid JSON / isn't shaped like a change event.
export function parseChange(rawData) {
  if (typeof rawData !== "string") return null;
  let obj;
  try {
    obj = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (!obj || typeof obj.reason !== "string") return null;
  return { reason: obj.reason, payload: obj.payload };
}

// Fold a parsed change into the run state. Events for a different run, or unrelated
// topics, return the SAME state reference (so React can skip the re-render).
export function reduceRunEvent(state, change) {
  if (!change || !state.runId) return state;
  const p = change.payload || {};
  if (p.runId !== state.runId) return state;

  if (change.reason === "workflow:step-change" && typeof p.nodeId === "string") {
    return { ...state, nodeStates: { ...state.nodeStates, [p.nodeId]: p.status } };
  }
  if (change.reason === "workflow:run-change") {
    return { ...state, runStatus: p.status };
  }
  return state;
}
