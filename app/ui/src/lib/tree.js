// Build a parent-child tree from the flat WorkerRow[] returned by /workers.
// Roots are rows with no parent_id (or whose parent_id points to a missing
// row). Children are sorted by started_at ASC inside each parent.

import { basename } from "./path.js";
import { sameJson } from "./sameJson.js";

// Roots with no known project directory land in this bucket, rendered last.
const OTHER_GROUP_KEY = "__other__";
// "No folder" roots (each in its own scratch folder) share one group, just before "Other".
const SCRATCH_GROUP_KEY = "__scratch__";

// Partition top-level agent roots into project groups, keyed by their project
// directory (worktree_from — the original project of a worktree agent — falling
// back to cwd). A registered project (projects[]) claims every root whose dir is
// one of its folders and names the group; its path is the primary folder, and it
// shows even with no roots. Roots keep their incoming order (started_at ASC from
// buildAgentTree). Groups are alphabetical by name — pinned projects first, then
// "No folder" and the "Other" bucket (no known project) always last — so a group
// stays put when its sessions are added, deleted or change status.
export function groupRootsByProject(roots, projects = []) {
  const groups = new Map();
  const groupFor = (key, init) => {
    let g = groups.get(key);
    if (!g) { g = { key, roots: [], ...init }; groups.set(key, g); }
    return g;
  };
  const projectGroup = (p) => groupFor(`project:${p.id}`, { path: p.folders[0], name: p.name, project: p });
  for (const r of roots) {
    if (r.scratch) {
      groupFor(SCRATCH_GROUP_KEY, { path: null, name: "No folder", scratch: true }).roots.push(r);
      continue;
    }
    const path = r.worktree_from ?? r.cwd ?? null;
    const project = path ? projects.find((p) => p.folders.includes(path)) : null;
    const g = project ? projectGroup(project)
      : groupFor(path ?? OTHER_GROUP_KEY, { path, name: path ? basename(path) : "Other" });
    g.roots.push(r);
  }
  for (const p of projects) projectGroup(p);
  const rank = (g) => (g.project?.pinned ? 0 : g.key === OTHER_GROUP_KEY ? 3 : g.scratch ? 2 : 1);
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || byName(a, b));
}

export function buildAgentTree(workers) {
  const byId = new Map();
  for (const w of workers) byId.set(w.id, { ...w, children: [] });
  const roots = [];
  for (const w of byId.values()) {
    const pid = w.parent_id;
    if (pid && byId.has(pid)) byId.get(pid).children.push(w);
    else roots.push(w);
  }
  const sortByStart = (a, b) => (a.started_at ?? 0) - (b.started_at ?? 0);
  for (const node of byId.values()) node.children.sort(sortByStart);
  roots.sort(sortByStart);
  return roots;
}

// `next` with every node that did not change swapped for its object in `prev`
// (same fields, same children objects), so rows memoized on their node skip a
// re-render unless their own worker or one below it changed.
export function keepUnchangedNodes(next, prev) {
  const before = new Map();
  const index = (nodes) => { for (const n of nodes) { before.set(n.id, n); index(n.children); } };
  index(prev);
  const keep = (n) => {
    n.children = n.children.map(keep);
    const old = before.get(n.id);
    return old && sameNode(old, n) ? old : n;
  };
  return next.map(keep);
}

function sameNode(a, b) {
  if (a.children.length !== b.children.length || a.children.some((c, i) => c !== b.children[i])) return false;
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((k) => k === "children" || sameJson(a[k], b[k]));
}

export function flattenVisibleAgents(tree, collapsed) {
  const out = [];
  function walk(node, depth) {
    out.push({ ...node, depth });
    if (collapsed.has(node.id)) return;
    for (const c of node.children) walk(c, depth + 1);
  }
  for (const r of tree) walk(r, 0);
  return out;
}

export function agentIdAtIndex(workers, collapsed, index) {
  const flat = flattenVisibleAgents(buildAgentTree(workers), collapsed);
  return flat[index]?.id ?? null;
}

// rootId plus all its descendants. Used to purge per-agent UI state when a
// delete cascades to children daemon-side.
export function subtreeIds(workers, rootId) {
  const childrenOf = new Map();
  for (const w of workers) {
    if (!w.parent_id) continue;
    if (!childrenOf.has(w.parent_id)) childrenOf.set(w.parent_id, []);
    childrenOf.get(w.parent_id).push(w.id);
  }
  const out = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    out.push(id);
    for (const c of childrenOf.get(id) ?? []) stack.push(c);
  }
  return out;
}
