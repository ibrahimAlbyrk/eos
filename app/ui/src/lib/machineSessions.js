// A machine's agents at a glance — the Machines menu cards and the All machines
// columns: how many run, how many wait on the human, and the few rows worth
// showing (waiting first, then running, then the most recent).

import { statusFromState } from "./format.js";
import { nameOf } from "./agentName.js";

const RUNNING = new Set(["WORKING", "SPAWNING"]);

export function summarizeSessions(workers, pending, limit = 3) {
  const list = Array.isArray(workers) ? workers.filter((w) => !w.archived_at) : [];
  const waiting = new Set((Array.isArray(pending) ? pending : []).filter((p) => !p.resolved).map((p) => p.worker_id));
  const running = list.filter((w) => RUNNING.has(w.state)).length;
  const rank = (w) => (waiting.has(w.id) ? 0 : RUNNING.has(w.state) ? 1 : 2);
  const rows = [...list]
    .sort((a, b) => rank(a) - rank(b) || (b.turn_started_at ?? b.started_at ?? 0) - (a.turn_started_at ?? a.started_at ?? 0))
    .slice(0, limit)
    .map((w) => {
      const needs = waiting.has(w.id);
      const st = statusFromState(w.state);
      return { id: w.id, name: nameOf(w), dot: needs ? "need" : st.dot, status: needs ? "input" : st.label, needs };
    });
  return { running, needs: waiting.size, idle: list.length - running, total: list.length, rows };
}
