import { groupRootsByProject } from "../../../lib/tree.js";
import { basename } from "../../../lib/path.js";

// Open sessions grouped under their folder (the same grouping the Agents
// sidebar uses), followed by the known folders that have no session yet.
// sessions: [{ id, cwd, ... }] in pane order · folders: paths.
export function folderGroups(sessions, folders) {
  const groups = groupRootsByProject(sessions);
  const seen = new Set(groups.map((g) => g.path));
  for (const p of folders) {
    if (!seen.has(p)) groups.push({ key: p, path: p, name: basename(p), roots: [] });
  }
  return groups;
}
