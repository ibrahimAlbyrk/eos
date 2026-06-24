// GoalCheckStrategy port — decides whether a loop's goal is met. Adapters:
// DeterministicCommandStrategy (infra, P2) runs each criterion's verify command;
// the LLM judge + hybrid land in P3. The verdict shape is the shared contracts
// GoalVerdict so every strategy speaks the same language.

import type { GoalSpec, GoalVerdict } from "../../../contracts/src/loop.ts";
import type { StrategyProgressSink } from "./LoopProgressSink.ts";

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
  // Live progress sink — a strategy reports its running phase (verifying/judging)
  // here so the daemon can show a "checking" indicator. Optional: absent on a
  // non-feedback caller (e.g. a unit test), so every strategy must null-check it.
  progress?: StrategyProgressSink;
}

export interface GoalCheckStrategy {
  evaluate(goal: GoalSpec, ctx: GoalContext): Promise<GoalVerdict>;
}
