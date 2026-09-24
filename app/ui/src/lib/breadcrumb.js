import { basename } from "./path.js";
import { nameOf } from "./agentName.js";
import { projectForPath, projectLabel } from "./projects.js";

// Breadcrumb model for the center header: project name + the selected agent's
// ancestor chain, root-first (orchestrator → … → selected). The project name
// comes from the chain root — worktree workers carry a NULL cwd, so their own
// fields would name the worktree, not the project.
export function breadcrumbFor(workers, selectedId, fallbackCwd) {
  const byId = new Map(workers.map((w) => [w.id, w]));
  const chain = [];
  const seen = new Set();
  let node = selectedId ? byId.get(selectedId) ?? null : null;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    chain.unshift(node);
    node = node.parent_id ? byId.get(node.parent_id) ?? null : null;
  }
  const root = chain[0] ?? null;
  const project =
    basename(root?.cwd ?? root?.worktree_from ?? fallbackCwd ?? "") || "—";
  return { project, chain: chain.map((w) => ({ id: w.id, label: nameOf(w), worker: w })) };
}

// The pre-spawn folder for the new-task / new-session screen: the composer's
// chosen cwd, else the most recent project. Returns project=null when no folder
// is available at all — the new-task headline drops its "in <project>" clause and
// the header omits the faint project name entirely. A registered project owning
// the folder lends its name.
export function newSessionProject(composerCwd, recents, projects = []) {
  const cwd = composerCwd ?? recents?.[0] ?? null;
  return { cwd, project: cwd ? projectLabel(projectForPath(projects, cwd), cwd) : null };
}

// Full project PATH (not just the basename) of the selected agent's chain root —
// the orchestrator's own cwd. Worktree workers carry a null cwd, so the path
// comes from the root, exactly as breadcrumbFor derives the project name. Returns
// null when nothing is selected or the root path is unknown (caller omits cwd).
export function projectPathFor(workers, selectedId) {
  const byId = new Map(workers.map((w) => [w.id, w]));
  const seen = new Set();
  let node = selectedId ? byId.get(selectedId) ?? null : null;
  let root = null;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    root = node;
    node = node.parent_id ? byId.get(node.parent_id) ?? null : null;
  }
  return root?.cwd ?? root?.worktree_from ?? null;
}
