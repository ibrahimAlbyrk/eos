// Build a parent-child tree from the flat WorkerRow[] returned by /workers.
// Roots are rows with no parent_id (or whose parent_id points to a missing
// row). Children are sorted by started_at ASC inside each parent.

import { basename } from "./path.js";

// Roots with no known project directory land in this bucket, rendered last.
const OTHER_GROUP_KEY = "__other__";

// Partition top-level agent roots into project groups, keyed by their project
// directory (worktree_from — the original project of a worktree agent — falling
// back to cwd). Roots keep their incoming order (started_at ASC from
// buildAgentTree); groups appear in the order their first root does, with the
// "Other" bucket (no known project) always last. Deterministic — nothing
// re-sorts as agent statuses change, so rows never jump around.
export function groupRootsByProject(roots) {
  const groups = new Map();
  for (const r of roots) {
    const path = r.worktree_from ?? r.cwd ?? null;
    const key = path ?? OTHER_GROUP_KEY;
    let g = groups.get(key);
    if (!g) {
      g = { key, path, name: path ? basename(path) : "Other", roots: [] };
      groups.set(key, g);
    }
    g.roots.push(r);
  }
  return [...groups.values()].sort(
    (a, b) => (a.key === OTHER_GROUP_KEY) - (b.key === OTHER_GROUP_KEY),
  );
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
