// GoalCheckStrategy port — decides whether a loop's goal is met. Adapters:
// DeterministicCommandStrategy (infra, P2) runs each criterion's verify command;
// the LLM judge + hybrid land in P3. The verdict shape is the shared contracts
// GoalVerdict so every strategy speaks the same language.

import type { GoalSpec, GoalVerdict } from "../../../contracts/src/loop.ts";
import type { StrategyProgressSink } from "./LoopProgressSink.ts";

// One shell command's machine result — the runner's return, mirroring runShell's
// ShellResult so the memoizing runner and the raw runShell are interchangeable.
export interface CommandResult {
  exitCode: number;
  output: string;
  // True only when `signal` cancelled the command before it finished (fail-fast).
  aborted?: boolean;
}

// A command executor shared across the strategies/collector of ONE goal check.
// The daemon injects a per-tick memoizing implementation so a hybrid check (which
// runs the deterministic strategy AND the evidence collector, each re-running the
// same verify commands) executes every distinct (cmd, cwd) exactly once. Optional
// `signal` preserves the deterministic strategy's fail-fast sibling-cancel.
export interface CommandRunner {
  run(cmd: string, cwd: string, signal?: AbortSignal): Promise<CommandResult>;
}

// What the strategy knows about the worker being checked. worktreeDir/branch are
// present when the worker runs in an isolated worktree (the verify cwd);
// lastReportText is the worker's held report (populated once report-hold lands).
export interface GoalContext {
  workerId: string;
  worktreeDir?: string;
  // The worker's checkout dir — the verify/file cwd for a worker with no isolated
  // worktree (a worker running directly in the operator's checkout). Strategies
  // resolve worktreeDir ?? cwd ?? repoRoot.
  cwd?: string;
  branch?: string;
  // The worker's stable fork point — the diff base so the judge sees the whole
  // contribution (committed-after-fork + uncommitted), not just uncommitted.
  forkBaseSha?: string;
  attempt: number;
  lastReportText?: string;
  // Per-check memoizing command runner (injected by the tick). Absent → the
  // strategy/collector falls back to its own runShell, so each stays independently
  // usable and testable.
  runCommand?: CommandRunner;
  // Live progress sink — a strategy reports its running phase (verifying/judging)
  // here so the daemon can show a "checking" indicator. Optional: absent on a
  // non-feedback caller (e.g. a unit test), so every strategy must null-check it.
  progress?: StrategyProgressSink;
}

export interface GoalCheckStrategy {
  evaluate(goal: GoalSpec, ctx: GoalContext): Promise<GoalVerdict>;
}
