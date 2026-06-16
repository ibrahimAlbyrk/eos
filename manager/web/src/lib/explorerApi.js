// Pure POSIX path helpers + drag-and-drop guards for the Files explorer. No
// React, no I/O — just string math over absolute "/"-separated paths.

export function parentDir(p) {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function baseName(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

export function joinPath(dir, name) {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

// The directory an entry lives in (a folder is its own drop target).
export function dirOf(entry) {
  return entry.type === "directory" ? entry.absolutePath : parentDir(entry.absolutePath);
}

// True when `child` is `parent` itself or nested under it — used to reject
// dropping a folder into its own subtree.
export function isDescendant(parent, child) {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}
