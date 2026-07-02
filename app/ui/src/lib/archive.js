// Pure helpers for the archive surface. GET /workers/archived returns every
// archived row (whole subtrees, ADR-7); the sidebar lists only subtree ROOTS
// because restore/purge act on the root's whole subtree.

// An archived row is a root when its parent is null, purged (absent), or not
// itself archived (archiving a child of a live parent is legal). Non-archived
// rows never appear. Newest-archived first.
export function archivedRoots(rows) {
  const archivedById = new Map();
  for (const w of rows) {
    if (w.archived_at != null) archivedById.set(w.id, w);
  }
  return [...archivedById.values()]
    .filter((w) => !w.parent_id || !archivedById.has(w.parent_id))
    .sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0));
}

// One copy for every permanent-delete confirm (live kill and archived purge
// both run the same subtree-wide cascade).
export function permanentDeleteMessage(name, subtreeSize) {
  const kids = subtreeSize > 1 ? ` and its ${subtreeSize - 1} sub-agent${subtreeSize > 2 ? "s" : ""}` : "";
  return `Permanently delete "${name}"${kids}? The transcript is deleted and the worktree is removed — this cannot be undone.`;
}
