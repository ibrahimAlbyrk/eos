// Pure shaping for the Memory view: kept memories grouped (global ones by
// category, project ones by folder), the filter chips with counts, and the short
// labels each memory shows.

export const CATEGORY_OPTIONS = [
  { value: "about", label: "About me" },
  { value: "work-style", label: "How I work" },
  { value: "stack", label: "Stack" },
  { value: "other", label: "Other" },
];

export function projectLabel(path) {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

function groupKey(m) {
  return m.scope.kind === "project" ? `project:${m.scope.path}` : `cat:${m.category}`;
}

function matches(m, query) {
  return !query || m.text.toLowerCase().includes(query.toLowerCase());
}

const newestFirst = (a, b) => b.updatedAt - a.updatedAt;

// [{ key, label, project, items }] — category groups in table order, then one per
// project folder (alphabetical). Empty groups are left out.
export function memoryGroups(memories, { query = "", filter = "all" } = {}) {
  const kept = (memories ?? []).filter((m) => m.status === "active" && matches(m, query));
  const groups = new Map();
  for (const c of CATEGORY_OPTIONS) groups.set(`cat:${c.value}`, { key: `cat:${c.value}`, label: c.label, project: null, items: [] });
  const projects = [...new Set(kept.filter((m) => m.scope.kind === "project").map((m) => m.scope.path))].sort();
  for (const p of projects) groups.set(`project:${p}`, { key: `project:${p}`, label: projectLabel(p), project: p, items: [] });
  for (const m of kept) groups.get(groupKey(m))?.items.push(m);
  return [...groups.values()]
    .filter((g) => g.items.length && (filter === "all" || filter === g.key))
    .map((g) => ({ ...g, items: g.items.sort(newestFirst) }));
}

// The chip row: "All" plus one per non-empty group, each with its count.
export function memoryFilters(memories) {
  const groups = memoryGroups(memories);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return [{ key: "all", label: "All", count: total }, ...groups.map((g) => ({ key: g.key, label: g.label, count: g.items.length }))];
}

export function sourceLabel(m) {
  if (m.source.kind === "agent") return `Learned · ${m.source.agentName}`;
  if (m.source.kind === "import") return "Imported";
  return "You";
}
