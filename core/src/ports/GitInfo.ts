// GitInfo — read-only port for inspecting a git working directory. Adapter
// shells out to the `git` binary; we keep the interface narrow so any future
// libgit2 implementation can plug in without disturbing callers.

import type { ChangedFile, FileDiffResponse } from "../../../contracts/src/http.ts";

export interface DiffStat {
  insertions: number;
  deletions: number;
  files: number;
}

export interface SyncStatus {
  ahead: number;
  behind: number;
}

export interface GitInfo {
  listBranches(cwd: string): Promise<string[]>;
  currentBranch(cwd: string): Promise<string | null>;
  diffShortStat(cwd: string): Promise<DiffStat>;
  checkout(cwd: string, branch: string): Promise<void>;
  remoteUrl(cwd: string): Promise<string | null>;
  syncStatus(cwd: string): Promise<SyncStatus | null>;
  stashCount(cwd: string): Promise<number>;
  conflictCount(cwd: string): Promise<number>;
  changedFiles(cwd: string): Promise<ChangedFile[]>;
  fileDiff(cwd: string, path: string, oldPath?: string): Promise<FileDiffResponse>;
}
