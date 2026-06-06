import { basename } from "./path.js";

// Worker name feeds the spawner's `cm-<name>-` mkdtemp prefix — a "/" (common
// in branch names) would nest the temp path, so strip it to "-".
const safe = (s) => String(s).replaceAll("/", "-").trim();

export function gitAgentName(cwd, branch, label) {
  return [cwd ? basename(cwd) : null, branch, label]
    .filter(Boolean)
    .map(safe)
    .join(" · ") || "git";
}

export function gitTaskLabel(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > 24 ? t.slice(0, 24).trimEnd() + "…" : t;
}
