// A turn the agent answered with silence leaves nothing to read, so it must not
// light the sidebar's unread dot. The worker row cannot tell such a turn from
// any other (tokens and tool calls moved), so each turn that began with a
// reaction reaching the agent is followed here, and its end is read once.
//
// Per worker: "told" (the agent was just told a reaction) → "turn" (it is
// working on it) → "checking" (it stopped; its newest rows are being read) →
// "silent" (it called no_reply) until it works again. From "turn" on the dot is
// held back; a turn that did say something lets it through. "told-quiet" is
// "told" for a worker whose dot was already held back.

import { api } from "../api/client.js";
import { isStopped } from "../lib/agentAttention.js";
import { endedWithNoReply } from "../lib/reactions.js";

// Enough rows to hold the end of a turn that only reacted or stayed silent.
const TAIL_ROWS = 40;

const stages = new Map(); // workerId → "told" | "told-quiet" | "turn" | "checking" | "silent"
const subs = new Set();

function emit() {
  for (const cb of subs) cb();
}

export function subscribeQuietTurns(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

// The agent has been told a reaction of the user's (reactions:change, seen).
export function noteReactionTold(workerId) {
  stages.set(workerId, isQuietTurn(workerId) ? "told-quiet" : "told");
}

export function isQuietTurn(workerId) {
  const stage = stages.get(workerId);
  return stage !== undefined && stage !== "told";
}

const newestRows = (workerId) => api.getWorkerEvents(workerId, { order: "desc", limit: TAIL_ROWS });

async function check(workerId, readRows) {
  let silent = false;
  try {
    silent = endedWithNoReply(await readRows(workerId));
  } catch {
    // Unread: the dot shows, as for any turn.
  }
  if (stages.get(workerId) !== "checking") return;
  if (silent) stages.set(workerId, "silent");
  else stages.delete(workerId);
  emit();
}

// One pass per workers update.
export function syncQuietTurns(workers, readRows = newestRows) {
  if (stages.size === 0) return;
  const seen = new Set();
  for (const w of workers) {
    const stage = w?.id ? stages.get(w.id) : undefined;
    if (stage === undefined) continue;
    seen.add(w.id);
    const stopped = isStopped(w.state);
    if ((stage === "told" || stage === "told-quiet") && !stopped) stages.set(w.id, "turn");
    else if (stage === "turn" && stopped) {
      stages.set(w.id, "checking");
      void check(w.id, readRows);
    } else if (stage === "silent" && !stopped) stages.delete(w.id);
  }
  for (const id of [...stages.keys()]) if (!seen.has(id)) stages.delete(id);
}

// Test-only: reset the module singleton between cases.
export function _reset() {
  stages.clear();
  subs.clear();
}
