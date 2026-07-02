// Pure helpers for the symbol-intelligence UI (go-to-def / find-refs / symbol
// search). No I/O — the store owns fetching; these just shape occurrences for
// the list rows. A SymbolOccurrence is { name, kind, role, path, line, column,
// lineText? } per the settled /symbols contract.

// Group occurrences by their file path, preserving first-seen file order and
// per-file occurrence order. Returns [{ path, items }].
export function groupByFile(occurrences) {
  const groups = new Map();
  for (const occ of occurrences ?? []) {
    let bucket = groups.get(occ.path);
    if (!bucket) { bucket = []; groups.set(occ.path, bucket); }
    bucket.push(occ);
  }
  return [...groups.entries()].map(([path, items]) => ({ path, items }));
}

// A short, human path for a result row: relative to the browsed root when the
// occurrence lives under it, else the bare basename.
export function relToRoot(path, root) {
  if (root && path.startsWith(root + "/")) return path.slice(root.length + 1);
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

// A compact glyph per tree-sitter tag kind for the symbol-search rows. Unknown
// kinds fall back to a neutral dot — coverage is data, not code.
const KIND_GLYPH = {
  function: "ƒ", method: "ƒ", class: "◆", interface: "◇", type: "T",
  struct: "◆", enum: "▤", constant: "π", variable: "𝑥", module: "⬡", field: "•",
};
export function kindGlyph(kind) {
  return KIND_GLYPH[kind] ?? "•";
}
