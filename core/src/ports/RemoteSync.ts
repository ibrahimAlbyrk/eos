// RemoteSync — narrow write port for operations that talk to a git remote:
// fetch (refresh remote-tracking refs), pull (fast-forward only — the WHAT is
// decided by pull-plan.ts), and remote-branch deletion. Separate from the
// local-only BranchAdmin and the read-only GitInfo (ISP). Never throws —
// failures come back classified, mirroring BranchPush.

import type { ActionablePullPlan, PullExecReason } from "../domain/pull-plan.ts";

export interface FetchResult {
  ok: boolean;
  summary?: string;   // short human summary (e.g. "Fetched origin")
  error?: string;
}

export interface PullExec {
  ok: boolean;        // git exited 0
  code: number;       // git exit code
  stdout: string;
  stderr: string;
  reason: PullExecReason;
}

export interface RemoteBranchDeleteResult {
  ok: boolean;
  error?: string;
}

export interface RemoteSync {
  /** `git fetch [--prune] [--all]`. No working-tree change. */
  fetch(cwd: string, opts: { remote?: string; prune: boolean }): Promise<FetchResult>;
  /** `git pull --ff-only`. Only the fast-forward plan reaches here — diverged
   *  plans are handed to the git agent, never auto-merged. */
  pull(cwd: string, plan: ActionablePullPlan): Promise<PullExec>;
  /** `git push <remote> --delete <branch>` — delete a branch on the remote. */
  deleteRemoteBranch(cwd: string, remote: string, branch: string): Promise<RemoteBranchDeleteResult>;
}
