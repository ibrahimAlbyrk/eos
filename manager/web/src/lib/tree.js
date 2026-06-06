// Build a parent-child tree from the flat WorkerRow[] returned by /workers.
// Roots are rows with no parent_id (or whose parent_id points to a missing
// row). Children are sorted by started_at ASC inside each parent.

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
