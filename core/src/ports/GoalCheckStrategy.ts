// GoalCheckStrategy port — decides whether a loop's goal is met. Adapters:
// DeterministicCommandStrategy (infra, P2) runs each criterion's verify command;
// the LLM judge + hybrid land in P3. The verdict shape is the shared contracts
// GoalVerdict so every strategy speaks the same language.

import type { GoalSpec, GoalVerdict } from "../../../contracts/src/loop.ts";

// What the strategy knows about the worker being checked. worktreeDir/branch are
// present when the worker runs in an isolated worktree (the verify cwd);
// lastReportText is the worker's held report (populated once report-hold lands).
export interface GoalContext {
  workerId: string;
  worktreeDir?: string;
  branch?: string;
  // The worker's stable fork point — the diff base so the judge sees the whole
  // contribution (committed-after-fork + uncommitted), not just uncommitted.
  forkBaseSha?: string;
  attempt: number;
  lastReportText?: string;
}

export interface GoalCheckStrategy {
  evaluate(goal: GoalSpec, ctx: GoalContext): Promise<GoalVerdict>;
}
