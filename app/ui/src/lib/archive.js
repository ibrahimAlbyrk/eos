// Pure helpers for the archive surface. GET /workers/archived returns every
// archived row (whole subtrees, ADR-7); the sidebar renders subtree ROOTS as
// top-level rows (restore/purge act on the root's whole subtree) with their
// archived descendants nested beneath, mirroring the live agent tree.

// A row is a root when its parent is null, purged (absent), or not itself
// archived (archiving a child of a live parent is legal). Non-archived rows
// never appear. Roots sort newest-archived first; children started_at ASC,
// same as the live tree.
export function archivedTree(rows) {
  const byId = new Map();
  for (const w of rows) {
    if (w.archived_at != null) byId.set(w.id, { ...w, children: [] });
  }
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const byStart = (a, b) => (a.started_at ?? 0) - (b.started_at ?? 0);
  for (const node of byId.values()) node.children.sort(byStart);
  return roots.sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0));
}

// One copy for every permanent-delete confirm (live kill and archived purge
// both run the same subtree-wide cascade).
export function permanentDeleteMessage(name, subtreeSize) {
  const kids = subtreeSize > 1 ? ` and its ${subtreeSize - 1} sub-agent${subtreeSize > 2 ? "s" : ""}` : "";
  return `Permanently delete "${name}"${kids}? The transcript is deleted and the worktree is removed — this cannot be undone.`;
}
