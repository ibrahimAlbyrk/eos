// Per-agent git snapshot cache (stale-while-revalidate). Components read the
// snapshot for THEIR workerId synchronously — switching agents shows at worst
// slightly-stale data for the right agent, never another agent's.

import { api } from "../api/client.js";
import { hasUnintegratedWork } from "../lib/workState.js";

const entries = new Map();

function entryOf(workerId) {
  let e = entries.get(workerId);
  if (!e) {
    e = { snapshot: null, inflight: null, subs: new Set() };
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

function buildSnapshot(diff, branches, push, tryState) {
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
    tryState: tryState ?? { activeTries: [], kept: false },
  };
}

// Drop a deleted agent's cached git snapshot. entryOf re-creates a fresh entry
// lazily if a live agent re-subscribes. (No debounce timer here, unlike
// diff/conflict stores.)
export function purge(workerId) {
  entries.delete(workerId);
}

export function revalidate(workerId, gitDir) {
  const e = entryOf(workerId);
  if (e.inflight) return e.inflight;
  e.inflight = (async () => {
    try {
      const [diff, branches, push, tryState] = await Promise.all([
        api.getWorkerDiff(workerId),
        gitDir ? api.listBranches(gitDir) : Promise.resolve(null),
        api.getPushState(workerId),
        api.getTryState(workerId),
      ]);
      e.snapshot = buildSnapshot(diff, branches, push, tryState);
      for (const cb of e.subs) cb();
    } catch {
      // Keep the previous snapshot — stale beats empty on a network blip.
    } finally {
      e.inflight = null;
    }
  })();
  return e.inflight;
}
