// Swappable grouping strategies for the agent sidebar. One interface —
// groupAgents(roots, mode, ctx) → [{ key, name, roots, path? }] — with three
// impls (folder / date / custom). Pure and deterministic: given the same inputs
// the group set and order never change, so rows don't jump as statuses update.
// Folder reuses the existing project grouping; only folder groups carry `path`
// (the per-group "+" pre-seat target).

import { groupRootsByProject } from "./tree.js";

export const UNGROUPED_KEY = "__ungrouped__";

const DAY_MS = 24 * 60 * 60 * 1000;

// Local midnight for the day containing `ts` — bucket boundaries are calendar
// days in the viewer's timezone, matching how a person reads "today".
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Fixed bucket order, newest first. `order` keeps groups deterministic even
// when a bucket is momentarily empty and later fills.
const DATE_BUCKETS = [
  { key: "today", name: "Today", order: 0 },
  { key: "yesterday", name: "Yesterday", order: 1 },
  { key: "week", name: "This week", order: 2 },
  { key: "older", name: "Older", order: 3 },
];

function dateBucketKey(startedAt, now) {
  const today = startOfDay(now);
  const day = startOfDay(startedAt ?? 0);
  if (day >= today) return "today";
  if (day >= today - DAY_MS) return "yesterday";
  if (day >= today - 6 * DAY_MS) return "week";
  return "older";
}

export function groupByDate(roots, now) {
  const byKey = new Map();
  for (const r of roots) {
    const key = dateBucketKey(r.started_at, now);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  return DATE_BUCKETS
    .filter((b) => byKey.has(b.key))
    .map((b) => ({ key: b.key, name: b.name, roots: byKey.get(b.key) }));
}

// Custom groups in their user-defined order (empty ones omitted), then a single
// "Ungrouped" bucket last for every root without a live assignment. An
// assignment pointing at a deleted group falls back to Ungrouped.
export function groupByCustom(roots, groups, assignments) {
  const valid = new Set(groups.map((g) => g.id));
  const byGroup = new Map();
  const ungrouped = [];
  for (const r of roots) {
    const gid = assignments[r.id];
    if (gid && valid.has(gid)) {
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid).push(r);
    } else {
      ungrouped.push(r);
    }
  }
  const out = [];
  for (const g of groups) {
    const rows = byGroup.get(g.id);
    if (rows && rows.length) out.push({ key: g.id, name: g.name, roots: rows });
  }
  if (ungrouped.length) out.push({ key: UNGROUPED_KEY, name: "Ungrouped", roots: ungrouped });
  return out;
}

// Dispatch. ctx = { now, groups, assignments }; unknown modes fall back to folder.
export function groupAgents(roots, mode, ctx = {}) {
  if (mode === "date") return groupByDate(roots, ctx.now ?? Date.now());
  if (mode === "custom") return groupByCustom(roots, ctx.groups ?? [], ctx.assignments ?? {});
  return groupRootsByProject(roots);
}
