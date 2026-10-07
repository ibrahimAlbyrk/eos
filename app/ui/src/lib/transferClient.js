// How the Transfer tab reaches the engine that moves files between Macs. The
// engine always runs on the Mac the user sits at, and speaks of it as "local".
//   local  — this Mac's own window: it calls this Mac's daemon directly.
//   bridge — a view of another Mac: its code can't reach this Mac's daemon, so
//            the shell's eosTransfer bridge carries a few calls — and this
//            Mac's paths only ever come from its own native pickers.
//   none   — a view running that Mac's own build: no way to this Mac's engine.

import { api } from "../api/client.js";
import { currentHost, hasLocalScreen, isRemoteView } from "./host.js";

const bridge = () => (typeof window !== "undefined" && window.eosTransfer) || null;

export function transferMode() {
  if (!isRemoteView()) return "local";
  return bridge() ? "bridge" : "none";
}

// The machine this view is of, in the engine's terms.
export function viewedMachine() {
  return isRemoteView() ? currentHost()?.id ?? null : "local";
}

// A view of another Mac never sees this Mac's disk; it picks files natively instead.
export function canBrowse(machine) {
  return transferMode() === "local" || machine === viewedMachine();
}

// The daemon whose disk `machine` is: null = this view's own.
const hostFor = (machine) => (machine === viewedMachine() ? null : machine);
const viaBridge = () => transferMode() === "bridge";

export const transfers = {
  list: () => (viaBridge() ? bridge().list() : api.listTransfers()),
  browse: (machine, path, opts) => api.transferList(hostFor(machine), path, opts),
  projectKey: (machine, path) => api.transferKey(hostFor(machine), path),
  locate: (machine, key) => api.transferLocate(hostFor(machine), key),
  destination: (body) => (viaBridge() ? bridge().destination(body) : api.transferDestination(body)),
  // `chosen`: in a view of another Mac, land in the folder last picked natively here.
  start: ({ from, to, paths, destDir, chosen }) =>
    viaBridge() ? bridge().pull({ paths, chosen: Boolean(chosen) }) : api.startTransfer({ from, to, paths, destDir: destDir ?? null }),
  // A view of another Mac sending this Mac's files: the native picker chooses them.
  pickAndSend: ({ destDir }) => bridge().push({ destDir }),
  chooseLocalFolder: () => bridge().chooseFolder(),
  pause: (id) => (viaBridge() ? bridge().act(id, "pause") : api.pauseTransfer(id)),
  resume: (id) => (viaBridge() ? bridge().act(id, "resume") : api.resumeTransfer(id)),
  cancel: (id) => (viaBridge() ? bridge().act(id, "cancel") : api.cancelTransfer(id)),
  decide: (id, decisions) => (viaBridge() ? bridge().act(id, "decide", decisions) : api.decideTransfer(id, decisions)),
  clear: () => (viaBridge() ? bridge().clear() : api.clearTransfers()),
  onChange: (cb) => (viaBridge() ? bridge().onChange(cb) : () => {}),
  // Show in Finder — only for what landed on this Mac, on this Mac's screen.
  canReveal: (t) => t.to === "local" && t.placed.length > 0 && (viaBridge() || hasLocalScreen()),
  reveal: (t) => (viaBridge() ? bridge().reveal(t.id) : api.revealFile(t.placed[0].path)),
};
