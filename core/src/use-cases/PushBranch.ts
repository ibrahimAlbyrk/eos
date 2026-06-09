// PushBranch — composes the deterministic push: read sync state, decide the
// plan (pure), execute it only when actionable, summarize. No agent involved.

import type { GitInfo } from "../ports/GitInfo.ts";
import type { BranchPush } from "../ports/BranchPush.ts";
import type { PushResult } from "../../../contracts/src/http.ts";
import { decidePushPlan, summarizePushResult, type PushExecReason } from "../domain/push-plan.ts";

export interface PushBranchDeps {
  git: GitInfo;
  branchPush: BranchPush;
}

export async function pushBranch(deps: PushBranchDeps, cwd: string): Promise<PushResult> {
  const state = await deps.git.pushState(cwd);
  const plan = decidePushPlan(state);

  let reason: PushExecReason | null = null;
  let detail: string | undefined;
  if (plan.kind === "set-upstream" || plan.kind === "fast-forward" || plan.kind === "force-with-lease") {
    const exec = await deps.branchPush.push(cwd, plan);
    reason = exec.reason;
    detail = (exec.stderr.trim() || exec.stdout.trim()) || undefined;
  }

  const summary = summarizePushResult(plan, reason);
  return {
    outcome: summary.outcome,
    ok: summary.ok,
    branch: state.branch,
    remote: state.remote,
    ahead: state.ahead,
    behind: state.behind,
    message: summary.message,
    ...(detail ? { detail } : {}),
  };
}
