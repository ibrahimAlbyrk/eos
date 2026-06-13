// PullBranch — composes the deterministic pull: read sync state, decide the
// plan (pure, fast-forward only), execute it only when actionable, summarize.
// A diverged branch is never auto-merged — that is the git agent's job.

import type { GitInfo } from "../ports/GitInfo.ts";
import type { RemoteSync } from "../ports/RemoteSync.ts";
import type { PullResult } from "../../../contracts/src/http.ts";
import { decidePullPlan, isActionablePullPlan, summarizePullResult, type PullExecReason } from "../domain/pull-plan.ts";

export interface PullBranchDeps {
  git: GitInfo;
  remoteSync: RemoteSync;
}

export async function pullBranch(deps: PullBranchDeps, cwd: string): Promise<PullResult> {
  const state = await deps.git.pullState(cwd);
  const plan = decidePullPlan(state);

  let reason: PullExecReason | null = null;
  let detail: string | undefined;
  if (isActionablePullPlan(plan)) {
    const exec = await deps.remoteSync.pull(cwd, plan);
    reason = exec.reason;
    detail = (exec.stderr.trim() || exec.stdout.trim()) || undefined;
  }

  const summary = summarizePullResult(plan, reason);
  return {
    outcome: summary.outcome,
    ok: summary.ok,
    branch: state.branch,
    ahead: state.ahead,
    behind: state.behind,
    message: summary.message,
    ...(detail ? { detail } : {}),
  };
}
