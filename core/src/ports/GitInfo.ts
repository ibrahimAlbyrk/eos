// GitInfo — read-only port for inspecting a git working directory. Adapter
// shells out to the `git` binary; we keep the interface narrow so any future
// libgit2 implementation can plug in without disturbing callers.

export interface DiffStat {
  insertions: number;
  deletions: number;
  files: number;
}

export interface GitInfo {
  listBranches(cwd: string): Promise<string[]>;
  currentBranch(cwd: string): Promise<string | null>;
  diffShortStat(cwd: string): Promise<DiffStat>;
}
