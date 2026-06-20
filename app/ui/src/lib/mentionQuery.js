// Navigation model for the `@`-mention menu. The text typed after `@` IS the
// browse state — these pure helpers derive the intent from it, so descend /
// ascend / breadcrumb are just rewrites of that fragment (no separate state).
//
//   ""        → browse the root (cwd)
//   "Comp"    → repo-wide search for "Comp"
//   "src/"    → browse "src"
//   "src/vi"  → browse "src", filtered by "vi"
//
// A "/" switches from repo-wide search to directory-scoped browse: the part
// before the last "/" is the directory, the part after is an in-dir filter.
export function resolveMentionQuery(fragment) {
  const slash = fragment.lastIndexOf("/");
  if (slash === -1) {
    return fragment
      ? { mode: "search", dir: "", filter: fragment }
      : { mode: "browse", dir: "", filter: "" };
  }
  return { mode: "browse", dir: fragment.slice(0, slash), filter: fragment.slice(slash + 1) };
}

// Parent directory of a browse scope, or null when already at the root.
//   "src/views" → "src"   |   "src" → ""   |   "" → null
export function parentScope(dir) {
  if (!dir) return null;
  const slash = dir.lastIndexOf("/");
  return slash === -1 ? "" : dir.slice(0, slash);
}

// Breadcrumb segments for a browse scope: "src/views" → ["src", "views"].
export function mentionCrumbs(dir) {
  return dir ? dir.split("/") : [];
}
