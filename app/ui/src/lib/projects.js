// Pure helpers for user projects (a name, an icon and source folders; folders[0]
// is the primary the agents run in).

import { basename } from "./path.js";

export function projectForPath(projects, path) {
  if (!path) return null;
  return projects.find((p) => p.folders.includes(path)) ?? null;
}

export function projectLabel(project, path) {
  return project?.name ?? (path ? basename(path) : "");
}

export function tildePath(p) {
  return p ? p.replace(/^\/(Users|home)\/[^/]+/, "~") : "";
}

// git@github.com:owner/repo.git · https://host/owner/repo(.git) → "owner/repo".
export function remoteSlug(url) {
  if (!url) return null;
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

// Projects first (a folder a project claims never repeats), then recent folders
// no project owns. Each entry: { key, project, path, name }.
export function projectChoices(projects, recents) {
  const owned = new Set(projects.flatMap((p) => p.folders));
  return [
    ...projects.map((p) => ({ key: `project:${p.id}`, project: p, path: p.folders[0], name: p.name })),
    ...recents.filter((r) => !owned.has(r)).map((r) => ({ key: r, project: null, path: r, name: basename(r) })),
  ];
}
