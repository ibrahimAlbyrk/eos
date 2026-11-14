// What a permission ask is about, for the card: the command or path it
// shows, and whether a file edit writes outside the chat's folder.

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** The path a file-edit tool writes (absolute, as the policy saw it), or null. */
export function editTarget(toolName, input) {
  if (!FILE_EDIT_TOOLS.has(toolName)) return null;
  const path = input?.file_path ?? input?.notebook_path;
  return typeof path === "string" && path ? path : null;
}

function segments(path) {
  const out = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out;
}

/** Whether absolute `path` lies outside folder `cwd` (true when either is unknown or relative). */
export function isOutsideFolder(path, cwd) {
  if (!path?.startsWith("/") || !cwd?.startsWith("/")) return false;
  const p = segments(path);
  const c = segments(cwd);
  return p.length <= c.length || c.some((s, i) => p[i] !== s);
}

/** The card's detail line and whether the ask is a write outside the worker's folder. */
export function permissionTarget(toolName, input, worker) {
  const target = editTarget(toolName, input);
  const detail = input?.command ?? target ?? input?.file_path ?? input?.path ?? input?.query ?? input?.regex ?? "";
  return { detail, outside: Boolean(target) && isOutsideFolder(target, worker?.cwd) };
}
