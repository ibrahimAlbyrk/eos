// remotePickerStore — the in-app stand-in for the native folder/file pickers in
// a view of another computer. The native dialog would open on THAT computer's
// screen; this browses its disk here instead and answers in the same shape the
// daemon's picker routes do ({ path } / { paths } / { cancelled }).

import { useSyncExternalStore } from "react";

let state = { request: null }; // { mode: "directory" | "files", resolve }
const subs = new Set();

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getState = () => state;

export function useRemotePicker() {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function requestRemotePick(mode) {
  return new Promise((resolve) => {
    state.request?.resolve({ cancelled: true });
    set({ request: { mode, resolve } });
  });
}

export function finishRemotePick(result) {
  const req = state.request;
  set({ request: null });
  req?.resolve(result ?? { cancelled: true });
}
