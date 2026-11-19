// runSheetStore — asks for the run sheet: a routine's Run button opens it next
// to the button. The sheet registers itself as the host; until one has, no Run
// button shows, since nothing would answer it.

import { useSyncExternalStore } from "react";

// hosted: how many sheet hosts are mounted. request: null, or the routine to
// run and the element the sheet opens beside.
let state = { hosted: 0, request: null };
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

export function useRunSheet() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// The sheet's host calls this when it mounts → the call that unregisters it.
export function registerHost() {
  set({ hosted: state.hosted + 1 });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    set({ hosted: state.hosted - 1, request: state.hosted === 1 ? null : state.request });
  };
}

export function open({ routineId, anchor }) {
  if (state.hosted === 0) return;
  set({ request: { routineId, anchor } });
}

export function close() {
  if (state.request) set({ request: null });
}

export function _resetRunSheet() {
  state = { hosted: 0, request: null };
}
