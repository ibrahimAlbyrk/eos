// Pure tree-builder for the Git Diff panel's file sidebar. Turns a flat
// ChangedFile[] into a nested dir/file node list: single-child dir chains are
// compressed into one "a/b/c" row (GitHub-style), insertions/deletions
// aggregate bottom-up (binary files have null counts — skipped, flagged), and
// each level sorts dirs-first alphabetically.

function newDir(label, path) {
  return { type: "dir", label, path, children: [], _dirs: new Map() };
}

export function buildFileTree(files) {
  const root = newDir("", "");
  for (const file of files ?? []) {
    const segs = file.path.split("/");
    let node = root;
    for (const seg of segs.slice(0, -1)) {
      let child = node._dirs.get(seg);
      if (!child) {
        child = newDir(seg, node.path ? `${node.path}/${seg}` : seg);
        node._dirs.set(seg, child);
      }
      node = child;
    }
    node.children.push({
      type: "file",
      label: segs[segs.length - 1],
      path: file.path,
      ins: file.insertions,
      del: file.deletions,
      file,
    });
  }
  return finalize(root).children;
}

// Compress chains and sort — one bottom-up pass per dir.
function finalize(dir) {
  const dirs = [...dir._dirs.values()].map(finalize);
  const files = dir.children;

  // A dir with exactly one subdir and no files collapses into that subdir.
  if (dir.path && dirs.length === 1 && files.length === 0) {
    const only = dirs[0];
    only.label = `${dir.label}/${only.label}`;
    return only;
  }

  dirs.sort((a, b) => a.label.localeCompare(b.label));
  files.sort((a, b) => a.label.localeCompare(b.label));
  dir.children = [...dirs, ...files];
  delete dir._dirs;
  return dir;
}
