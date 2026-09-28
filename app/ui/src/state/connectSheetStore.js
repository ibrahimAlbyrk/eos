// connectSheetStore — which provider the Connect sheet is open for (null =
// closed). A module singleton so the composer's provider picker can open the
// sheet that ConnectSheetHost renders once at the app root. The sheet closes once
// `ready(account)` holds (default: the account can run agents) and then calls
// `onConnected` (e.g. select the provider in the composer).

import { useSyncExternalStore } from "react";

let state = { provider: null, onConnected: null, ready: null };
const subs = new Set();

function set(next) {
  state = next;
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getState = () => state;

export function useConnectSheet() {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function openConnectSheet(provider, { onConnected = null, ready = null } = {}) {
  set({ provider, onConnected, ready });
}

export function closeConnectSheet() {
  if (state.provider) set({ provider: null, onConnected: null, ready: null });
}
