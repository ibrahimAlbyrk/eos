// Per-agent git snapshot cache (stale-while-revalidate). Components read the
// snapshot for THEIR workerId synchronously — switching agents shows at worst
// slightly-stale data for the right agent, never another agent's.
//
// A snapshot stays current until its dir reports a git change (gitVersion), its
// agent logs anything, or the stream reconnects: showing the agent again
// meanwhile sends no request (ensure). fs/branches answers are kept per dir and
// shared with #branch completion, so one switch asks once. The store holds a
// watch lease of its own on the dirs it answered for last, so their changes
// keep arriving after the views unmount; a dir past MAX_KEPT_DIRS is let go and
// what was cached for it counts as stale.

import { api } from "../api/client.js";
import { hasUnintegratedWork } from "../lib/workState.js";
import { gitVersion, subscribeGitChange } from "./gitChangeBus.js";

const MAX_KEPT_DIRS = 5;

const entries = new Map();
const branchAnswers = new Map(); // dir -> { version, value, inflight }
const keptDirs = new Map(); // dir -> lease release; insertion order = recency

function entryOf(workerId) {
  let e = entries.get(workerId);
  if (!e) {
    e = { snapshot: null, inflight: null, subs: new Set(), activity: 0, checked: null };
    entries.set(workerId, e);
  }
  return e;
}

export function getSnapshot(workerId) {
  return entries.get(workerId)?.snapshot ?? null;
}

export function subscribe(workerId, cb) {
  const e = entryOf(workerId);
  e.subs.add(cb);
  return () => {
    e.subs.delete(cb);
  };
}

function keepDir(dir) {
  const release = keptDirs.get(dir) ?? subscribeGitChange(dir, [], () => {});
  keptDirs.delete(dir);
  keptDirs.set(dir, release);
  for (const [old, rel] of keptDirs) {
    if (keptDirs.size <= MAX_KEPT_DIRS) break;
    keptDirs.delete(old);
    branchAnswers.delete(old);
    rel();
  }
}

// One fs/branches request per dir and version: the cached answer while nothing
// changed, else the request already in flight for this version, else a new
// one. `fresh` passes over a cached answer (an explicit refresh, the fallback
// poll) but still joins a request made since the last change.
export function branchesOf(dir, { fresh = false } = {}) {
  keepDir(dir);
  const version = gitVersion(dir);
  const known = branchAnswers.get(dir);
  if (known && known.version === version && (known.inflight || !fresh)) {
    return known.inflight ?? Promise.resolve(known.value);
  }
  const ask = { version, value: null, inflight: null };
  ask.inflight = api.listBranches(dir).then(
    (value) => {
      ask.value = value;
      ask.inflight = null;
      return value;
    },
    (err) => {
      if (branchAnswers.get(dir) === ask) branchAnswers.delete(dir);
      throw err;
    },
  );
  branchAnswers.set(dir, ask);
  return ask.inflight;
}

function buildSnapshot(diff, branches, push) {
  const d = diff ?? { insertions: 0, deletions: 0, files: 0 };
  const dirty = hasUnintegratedWork(d);
  return {
    // No branches response (no git dir yet) → assume git so the row stays
    // visible; a dirty diff forces git regardless of what branches said.
    isGit: branches ? branches.isGit !== false || dirty : true,
    diff: d,
    currentBranch: branches?.current ?? null,
    remoteUrl: branches?.remoteUrl ?? null,
    ahead: branches?.ahead ?? 0,
    behind: branches?.behind ?? 0,
    stash: branches?.stash ?? 0,
    conflicts: branches?.conflicts ?? 0,
    pushable: push?.pushable ?? false,
    pushKind: push?.kind ?? "noop",
    hasUncommitted: push?.hasUncommitted ?? false,
    pullable: push?.pullable ?? false,
    pullKind: push?.pullKind ?? "noop",
  };
}

// Drop a deleted agent's cached git snapshot. entryOf re-creates a fresh entry
// lazily if a live agent re-subscribes. (No debounce timer here, unlike
// diff/conflict stores.)
export function purge(workerId) {
  entries.delete(workerId);
}

// Drop entries for workers no longer in the live list — auto-shutdown, cascade
// death, and daemon-restart disappearance never reach the explicit-delete purge.
export function pruneExcept(presentIds) {
  for (const id of [...entries.keys()]) if (!presentIds.has(id)) purge(id);
}

// The agent logged something: its tools may have changed its checkout where no
// watch looks (a tree too large to watch), so its snapshot is asked again.
export function noteWorkerActivity(workerId) {
  const e = entries.get(workerId);
  if (e) e.activity++;
}

const isCurrent = (e, gitDir) =>
  e.snapshot != null && e.checked != null && e.checked.gitDir === gitDir && e.checked.version != null
  && e.checked.version === gitVersion(gitDir) && e.checked.activity === e.activity;

// An agent shown again: its snapshot is asked for only when something changed.
export function ensure(workerId, gitDir) {
  if (gitDir) keepDir(gitDir);
  const e = entryOf(workerId);
  if (isCurrent(e, gitDir)) return e.inflight ?? Promise.resolve();
  return revalidate(workerId, gitDir, { fresh: false });
}

export function revalidate(workerId, gitDir, { fresh = true } = {}) {
  const e = entryOf(workerId);
  if (e.inflight) return e.inflight;
  const checked = { gitDir, version: gitDir ? gitVersion(gitDir) : null, activity: e.activity };
  e.inflight = (async () => {
    try {
      const [diff, branches, push] = await Promise.all([
        api.getWorkerDiff(workerId),
        gitDir ? branchesOf(gitDir, { fresh }) : Promise.resolve(null),
        api.getPushState(workerId),
      ]);
      e.snapshot = buildSnapshot(diff, branches, push);
      e.checked = checked;
      for (const cb of e.subs) cb();
    } catch {
      // Keep the previous snapshot — stale beats empty on a network blip.
    } finally {
      e.inflight = null;
    }
  })();
  return e.inflight;
}
