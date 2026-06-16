// Pure tree -> flat-list projection for the Files explorer. Walks only the
// expanded directories (collapsed subtrees cost nothing) and emits one row per
// visible node, depth-tagged. Loading / empty / error directories emit a single
// marker row so the UI can show state inline at the right indent. This flat
// array is the single source for rendering, keyboard order, and range select.
//
//   cache: Map<dirAbsPath, { state: "loading"|"ready"|"error", entries: FsEntry[] }>
//   expanded: Set<dirAbsPath>
//
// Node shapes:
//   { kind: "entry", path, name, type, isSymlink, depth, expandable }
//   { kind: "loading"|"empty"|"error", path, depth }   (path is a synthetic key)

export function flattenVisible(root, expanded, cache) {
  const out = [];
  if (!root) return out;

  const visit = (dir, depth) => {
    const node = cache.get(dir);
    if (!node || node.state === "loading") {
      out.push({ kind: "loading", path: `${dir}::loading`, depth });
      return;
    }
    if (node.state === "error") {
      out.push({ kind: "error", path: `${dir}::error`, depth });
      return;
    }
    if (node.entries.length === 0) {
      out.push({ kind: "empty", path: `${dir}::empty`, depth });
      return;
    }
    for (const e of node.entries) {
      out.push({
        kind: "entry",
        path: e.absolutePath,
        name: e.name,
        type: e.type,
        isSymlink: e.isSymlink === true,
        depth,
        expandable: e.type === "directory",
      });
      if (e.type === "directory" && expanded.has(e.absolutePath)) visit(e.absolutePath, depth + 1);
    }
  };

  visit(root, 0);
  return out;
}
