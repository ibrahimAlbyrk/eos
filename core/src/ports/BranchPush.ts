// BranchPush — narrow write port for pushing a branch to its remote. Kept
// separate from the read-only GitInfo port (ISP): the decision of WHAT to push
// is pure domain (push-plan.ts); this port only executes one already-decided
// plan. Mirrors WorktreeManager/BranchIntegration as a focused write port.

import type { ActionablePushPlan, PushExecReason } from "../domain/push-plan.ts";

export interface PushExec {
  ok: boolean;        // git exited 0
  code: number;       // git exit code
  stdout: string;
  stderr: string;
  reason: PushExecReason;
}

export interface BranchPush {
  /** Runs the resolved git push. Only actionable plans reach here — noop/blocked
   *  are settled by the caller without invoking git. Never throws: failures are
   *  returned as a classified PushExec. */
  push(cwd: string, plan: ActionablePushPlan): Promise<PushExec>;
}
