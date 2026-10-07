// remotePickerStore — the in-app stand-in for the native folder/file pickers in
// a view of another computer. The native dialog would open on THAT computer's
// screen; this browses its disk here instead and answers in the same shape the
// daemon's picker routes do ({ path } / { paths } / { cancelled }).

import { useSyncExternalStore } from "react";

// { mode: "directory" | "files", resolve, source? } — `source` browses some other
// disk ({ list(path) → { entries }, home, where }), e.g. the Transfer tab's
// destination on a paired Mac; absent, the view's own computer.
let state = { request: null };
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

export function requestRemotePick(mode, source = null) {
  return new Promise((resolve) => {
    state.request?.resolve({ cancelled: true });
    set({ request: { mode, resolve, source } });
  });
}

export function finishRemotePick(result) {
  const req = state.request;
  set({ request: null });
  req?.resolve(result ?? { cancelled: true });
}
