import type { Project } from "../../../contracts/src/http.ts";

// The extra source folders a session gets beyond its own working dir: the other
// folders of the first project owning any of `paths` (the worker's cwd, and the
// source repo when it runs in a worktree). Empty when no project claims it.
export function additionalDirsFor(projects: readonly Project[], paths: readonly (string | null | undefined)[]): string[] {
  const own = paths.filter((p): p is string => !!p);
  const project = projects.find((p) => p.folders.some((f) => own.includes(f)));
  return project ? project.folders.filter((f) => !own.includes(f)) : [];
}
