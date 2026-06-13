// Pure helpers for turning a remote-tracking ref label (as it appears in the
// branch picker, e.g. "origin/feature/x") into the local branch name to check
// out. Stripping the remote prefix lets `git checkout <name>` DWIM-create a
// local tracking branch instead of landing on a detached HEAD.

export function isRemoteBranch(branch: string, remotes: string[]): boolean {
  return remotes.some((r) => branch.startsWith(r + "/"));
}

export function stripRemotePrefix(branch: string, remotes: string[]): string {
  // Longest remote name first so "origin/foo" isn't half-stripped by a remote
  // literally named "orig" (defensive — strip the most specific match).
  for (const r of [...remotes].sort((a, b) => b.length - a.length)) {
    if (branch.startsWith(r + "/")) return branch.slice(r.length + 1);
  }
  return branch;
}
