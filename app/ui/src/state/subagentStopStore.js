import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { notify } from "../lib/notify.js";
import { isRunning } from "../lib/subagentRuns.js";

// The subagents the user asked to stop, by worker and subagent, from the click
// until its end arrives in the transcript (it then reads as Stopped).
const stopping = new Set(); // `${workerId} ${toolUseId}`
const listeners = new Set();
const keyOf = (workerId, run) => `${workerId} ${run.toolUseId}`;

function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function clear(key) {
  if (stopping.delete(key)) emit();
}

// One background subagent of the chat that is working: a foreground one ends
// with its parent's turn, and a workflow's agents stop with their run.
export function canStopSubagent(run) {
  return Boolean(run) && isRunning(run) && run.background === true && run.subagentType !== "workflow-subagent";
}

export function isStoppingSubagent(workerId, run) {
  return stopping.has(keyOf(workerId, run));
}

// Asks the core to stop `run` (a subagent summary). Resolves to "stopping"
// (its end follows), "ended" (it had already ended: nothing to say) or
// "failed" (the user is told).
export async function stopSubagent(workerId, run, request = api.stopSubagent) {
  const key = keyOf(workerId, run);
  if (stopping.has(key)) return "stopping";
  stopping.add(key);
  emit();
  // Its latest run's call: the one a resumed subagent was last started by.
  const callId = run.runs?.at(-1)?.toolUseId ?? run.toolUseId;
  try {
    const r = await request(workerId, callId);
    if (r.ok) return "stopping";
    clear(key);
    if (r.status === 409 && r.body?.code === "subagent_ended") return "ended";
    notify.error(`Couldn't stop the subagent: ${r.body?.error ?? `status ${r.status}`}`);
    return "failed";
  } catch (e) {
    clear(key);
    notify.error(`Couldn't stop the subagent: ${e instanceof Error ? e.message : String(e)}`);
    return "failed";
  }
}

// What a Stop control of `run` shows and does.
export function useSubagentStop(workerId, run) {
  const key = workerId && run ? keyOf(workerId, run) : null;
  const flagged = useSyncExternalStore(subscribe, () => (key ? stopping.has(key) : false), () => false);
  const running = Boolean(run) && isRunning(run);
  // Once it has ended the flag has done its work.
  useEffect(() => {
    if (key && flagged && !running) clear(key);
  }, [key, flagged, running]);
  const stop = useCallback(() => (workerId && run ? stopSubagent(workerId, run) : null), [workerId, run]);
  return { canStop: Boolean(workerId) && canStopSubagent(run), stopping: flagged && running, stop };
}
