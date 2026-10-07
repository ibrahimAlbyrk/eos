// transfersStore — this Mac's file transfers (the Transfer tab, the agent tool
// card). Every change arrives whole as a transfer:change payload: over this
// Mac's SSE in its own window, through the shell's bridge in a view of another
// Mac (whose SSE is that Mac's, not ours).

import { useSyncExternalStore } from "react";
import { transferMode, transfers } from "../lib/transferClient.js";

const ACTIVE = new Set(["queued", "scanning", "copying", "conflict", "committing"]);

let list = null;
const subs = new Set();
let started = false;

function set(next) {
  list = next;
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getList = () => list;

const newestFirst = (a, b) => b.createdAt - a.createdAt;

export function useTransfers() {
  return useSyncExternalStore(subscribe, getList, getList);
}

export function useTransfer(id) {
  const all = useTransfers();
  return id ? all?.find((t) => t.id === id) ?? null : null;
}

export const isActive = (t) => ACTIVE.has(t.status);

// Conflicts the user still has to answer.
export const undecided = (t) => t.conflicts.filter((c) => !t.decisions[c.name]);

export async function refreshTransfers() {
  // A view running another Mac's build has no way to this Mac's engine.
  if (transferMode() === "none") return null;
  const next = await transfers.list().catch(() => null);
  if (Array.isArray(next)) set([...next].sort(newestFirst));
  return next;
}

export function ensureTransfersLoaded() {
  if (started) return;
  started = true;
  transfers.onChange(applyTransferChange);
  void refreshTransfers();
}

// SSE transfer:change (useLive), or the bridge in a view of another Mac.
export function applyTransferChange(payload) {
  if (!payload || typeof payload !== "object") return;
  let next = list ?? [];
  if (payload.transfer?.id) next = [payload.transfer, ...next.filter((t) => t.id !== payload.transfer.id)].sort(newestFirst);
  if (Array.isArray(payload.removed)) next = next.filter((t) => !payload.removed.includes(t.id));
  set(next);
}

// The stream restarted (events may be missed) — refetch if anyone has looked.
export function resyncTransfers() {
  if (list) void refreshTransfers();
}

// A start/act answer is the transfer's new state — show it before its event lands.
export function noteTransfer(t) {
  if (t?.id) applyTransferChange({ transfer: t });
}
