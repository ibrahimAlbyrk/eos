// jobsStore — every background job the daemon knows (the header beacon and the
// Jobs tab). Loaded once on first use, then kept by jobs:change payloads (one
// job whole, or ids dropped); refetched when the stream restarts.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { sortJobs } from "../lib/jobs.js";

let list = null;
let started = false;
const subs = new Set();

function set(next) {
  list = next;
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getList = () => list;

// null until the first load lands.
export function useJobs() {
  return useSyncExternalStore(subscribe, getList, getList);
}

async function refreshJobs() {
  const next = await api.listJobs().catch(() => null);
  if (Array.isArray(next)) set(sortJobs(next));
}

export function ensureJobsLoaded() {
  if (started) return;
  started = true;
  void refreshJobs();
}

// SSE jobs:change (useLive).
export function applyJobsChange(payload) {
  if (!payload || typeof payload !== "object" || !list) return;
  let next = list;
  if (payload.job?.id) next = [payload.job, ...next.filter((j) => j.id !== payload.job.id)];
  if (Array.isArray(payload.removed)) next = next.filter((j) => !payload.removed.includes(j.id));
  set(sortJobs(next));
}

export function resyncJobs() {
  if (started) void refreshJobs();
}

// When the user last looked at the jobs (popover opened, Jobs tab on screen) —
// a failure after it keeps the beacon's dot lit.
let seenAt = Date.now();
const seenSubs = new Set();

export function markJobsSeen() {
  seenAt = Date.now();
  for (const cb of seenSubs) cb();
}

function subscribeSeen(cb) {
  seenSubs.add(cb);
  return () => seenSubs.delete(cb);
}

const getSeenAt = () => seenAt;

export function useJobsSeenAt() {
  return useSyncExternalStore(subscribeSeen, getSeenAt, getSeenAt);
}
