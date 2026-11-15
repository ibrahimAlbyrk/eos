// The worker event signal (useLive feeds it from the stream). tick: every event
// naming a worker (workerId: the last one). changeTick: only the worker changes
// that are not an agent's own output (lib/workerChange.js). A resync bumps both
// with no worker. A module store, so only its readers re-render on an event.

import { useSyncExternalStore } from "react";

let signal = { tick: 0, workerId: null, changeTick: 0 };
const subs = new Set();

function set(next) {
  signal = next;
  for (const cb of subs) cb();
}

export function noteWorkerEvent(workerId, stateChange) {
  set({ tick: signal.tick + 1, workerId, changeTick: signal.changeTick + (stateChange ? 1 : 0) });
}

export function noteResync() {
  set({ tick: signal.tick + 1, workerId: null, changeTick: signal.changeTick + 1 });
}

export function getEventSignal() {
  return signal;
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const noSubscribe = () => () => {};

// `enabled` false leaves the caller alone (it re-reads the signal when next drawn).
export function useEventSignal(enabled = true) {
  return useSyncExternalStore(enabled ? subscribe : noSubscribe, getEventSignal, getEventSignal);
}

const getChangeTick = () => signal.changeTick;

// Re-renders on the worker changes only, not on every agent event.
export function useChangeTick() {
  return useSyncExternalStore(subscribe, getChangeTick, getChangeTick);
}
