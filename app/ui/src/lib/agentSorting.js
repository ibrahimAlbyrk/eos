// Swappable sort comparators for the rows within a sidebar group. sortRoots
// returns a NEW array (never mutates); every comparator ends in an id tiebreak
// so the order is total and deterministic — no churn when primary keys tie.
// Applied to the top-level rows of each group; nested children keep their
// buildAgentTree order.

import { nameOf } from "./agentName.js";

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Most recent activity first: turn_started_at is stamped on every entry into
// the busy set, falling back to creation time for agents that never ran.
function recencyKey(w) {
  return w.turn_started_at ?? w.started_at ?? 0;
}

const COMPARATORS = {
  alpha: (a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" }) || byId(a, b),
  created: (a, b) => (a.started_at ?? 0) - (b.started_at ?? 0) || byId(a, b),
  recency: (a, b) => recencyKey(b) - recencyKey(a) || byId(a, b),
};

export function sortRoots(roots, sortBy) {
  const cmp = COMPARATORS[sortBy] ?? COMPARATORS.recency;
  return roots.slice().sort(cmp);
}
