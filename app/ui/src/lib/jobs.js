// Pure model of the background-jobs list (state/jobsStore.js): order, filters,
// grouping by chat, and the meta text each row shows.

import { fmtElapsed, fmtTimeAgoShort } from "./format.js";

export const isRunning = (job) => job.status === "running";

// Running first, newest start first; then finished, newest end first.
export function sortJobs(jobs) {
  return [...jobs].sort((a, b) => {
    const ar = isRunning(a), br = isRunning(b);
    if (ar !== br) return ar ? -1 : 1;
    return ar ? b.startedAt - a.startedAt : (b.endedAt ?? 0) - (a.endedAt ?? 0);
  });
}

export const JOB_FILTERS = [
  { id: "all", label: "All", kinds: null },
  { id: "shells", label: "Shells", kinds: ["shell", "monitor"] },
  { id: "workflows", label: "Workflows", kinds: ["workflow"] },
  { id: "eos", label: "Eos", kinds: ["transfer", "compaction", "dream", "sync", "update"] },
];

export function filterJobs(jobs, filterId) {
  const kinds = JOB_FILTERS.find((f) => f.id === filterId)?.kinds;
  return kinds ? jobs.filter((j) => kinds.includes(j.kind)) : jobs;
}

// The job's chat, or Eos for its own work. Groups keep the jobs' order; the
// group of the first job comes first.
export function groupBySource(jobs, chatName) {
  const groups = new Map();
  for (const job of jobs) {
    const key = job.workerId ?? "eos";
    if (!groups.has(key)) groups.set(key, { key, label: job.workerId ? chatName(job.workerId) : "Eos", jobs: [] });
    groups.get(key).jobs.push(job);
  }
  return [...groups.values()];
}

export const pctOf = (job) => (job.progress && job.progress.total ? Math.min(100, Math.round((job.progress.done / job.progress.total) * 100)) : null);

// Running: its share done, else how long it has run. Finished: how long ago.
export function jobMeta(job, now) {
  if (isRunning(job)) {
    const pct = pctOf(job);
    return pct !== null && job.kind !== "workflow" ? `${pct}%` : fmtElapsed(now - job.startedAt);
  }
  const ago = fmtTimeAgoShort(job.endedAt ?? now, now);
  return ago === "now" ? "just now" : `${ago} ago`;
}

// A command reads in mono; a name in the UI face.
export const titleIsCommand = (job) => job.command !== null && job.title === job.command;

// A failed job the user hasn't seen since `seenAt` (the beacon's dot).
export const hasUnseenFailure = (jobs, seenAt) => jobs.some((j) => j.status === "failed" && (j.endedAt ?? 0) > seenAt);
