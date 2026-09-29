// peerStore — hosting: other computers allowed to control THIS Mac (Settings ›
// Remote access) and which of them are connected right now (the "… connected"
// chip). Status comes from GET /api/peer; live presence rides the peer:presence
// SSE event so the chip appears the moment a device connects.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { isRemoteView } from "../lib/host.js";

let state = { status: null, presence: [] };
const subs = new Set();
let started = false;

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getPeerState() {
  return state;
}

export function usePeer() {
  return useSyncExternalStore(subscribe, getPeerState, getPeerState);
}

export async function refreshPeer() {
  const status = await api.getPeer().catch(() => null);
  if (!status) return null;
  set({ status, presence: status.devices.filter((d) => d.connected) });
  return status;
}

export function ensurePeerLoaded() {
  // A controlled computer's view shows its own identity chip instead; hosting
  // settings are this Mac's to manage.
  if (started || isRemoteView()) return;
  started = true;
  void refreshPeer();
}

// SSE peer:presence (useLive) — the connected set changed.
export function applyPresence(payload) {
  if (isRemoteView()) return;
  const devices = Array.isArray(payload?.devices) ? payload.devices : [];
  set({ presence: devices });
  if (state.status) void refreshPeer();
}
