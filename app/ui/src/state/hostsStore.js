// hostsStore — the computers this Mac controls: the footer machine row, the
// Machines menu, All machines and Settings › Machines. In the app the shell owns
// the list (window.eosHosts) and hands the same one to every view — this Mac's
// and each controlled computer's; a plain browser tab reads it from its daemon.
// Module singleton (the accountsStore idiom).

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { isRemoteView } from "../lib/host.js";

// local: this Mac as its daemon describes itself ({ name, platform, deviceId }).
// connectOpen: the Connect a machine sheet (opened from the Machines menu, the
// shell's Machines menu, Settings › Machines).
let state = { hosts: [], active: null, local: null, loaded: false, connectOpen: false };
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

export function getHostsState() {
  return state;
}

export function useHosts() {
  return useSyncExternalStore(subscribe, getHostsState, getHostsState);
}

function bridge() {
  return (typeof window !== "undefined" && window.eosHosts) || null;
}

// Switching needs the shell; without it (a browser tab) there is only this Mac.
export const canSwitchMachines = () => bridge() != null;

// Settings › Machines, pairing and forgetting talk to THIS Mac's daemon — only
// its own view holds the token for that.
export const canManageMachines = () => !isRemoteView();

export async function refreshHosts() {
  const b = bridge();
  if (b) {
    const snap = await b.list().catch(() => null);
    if (snap) applySnapshot(snap);
    return;
  }
  if (isRemoteView()) return;
  const [hosts, local] = await Promise.all([api.listHosts().catch(() => null), state.local ? state.local : api.hostInfo().catch(() => null)]);
  set({ ...(hosts ? { hosts } : {}), ...(local ? { local } : {}), loaded: true });
}

function applySnapshot(snap) {
  set({ hosts: snap.hosts ?? [], active: snap.active ?? null, local: snap.local ?? state.local, loaded: true });
}

export function ensureHostsLoaded() {
  if (started) return;
  started = true;
  bridge()?.onChange(applySnapshot);
  bridge()?.onCommand?.((cmd) => { if (cmd?.type === "connect" && canManageMachines()) openConnectSheet(); });
  void refreshHosts();
}

export function openConnectSheet() { set({ connectOpen: true }); }
export function closeConnectSheet() { set({ connectOpen: false }); }

export function switchMachine(id) {
  bridge()?.switchTo(id ?? null);
}

export function openMachineWindow(id) {
  bridge()?.openInWindow(id);
}

export function reconnectMachine(id) {
  const b = bridge();
  if (b) { b.reconnect(id); return; }
  void api.reconnectHost(id).then(() => refreshHosts());
}

// Pairing lives in this Mac's own view; from a controlled computer's view the
// shell switches back here with the Connect sheet open.
export function requestConnect() {
  if (canManageMachines()) { openConnectSheet(); return; }
  bridge()?.requestConnect?.();
}

// ---- selectors --------------------------------------------------------------

export const hostLabel = (h) => h?.alias || h?.name || "Remote Mac";

// The dot every surface shows next to a machine.
export function linkTone(link) {
  switch (link?.state) {
    case "live": return "ok";
    case "connecting":
    case "reconnecting": return "warn";
    case "unauthorized":
    case "incompatible": return "err";
    default: return "off";
  }
}

export function routeLabel(link) {
  if (!link) return "";
  if (link.state === "live") return link.route === "relay" ? "Relay" : link.route === "reverse" ? "Tunnel" : "Local network";
  if (link.state === "connecting") return "Connecting…";
  if (link.state === "reconnecting") return "Reconnecting…";
  if (link.state === "unauthorized") return link.error === "identity-changed" ? "ID changed" : "Not paired";
  if (link.error === "remote-access-off") return "Remote access off";
  if (link.error === "local-network") return "Local network blocked";
  return "Offline";
}

export function latencyLabel(link) {
  return link?.state === "live" && link.rttMs != null ? `${Math.max(1, Math.round(link.rttMs))} ms` : null;
}
