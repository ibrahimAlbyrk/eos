// DeterministicCommandStrategy — runs each criterion's `verify` shell command;
// exit 0 = met. A criterion with no verify command is unmet ("needs judge") —
// the LLM judge owns those. Overall met = every criterion met. Thin: no state,
// no parsing — just exit codes turned into a GoalVerdict.
//
// Fail-fast: `met` is the AND of all criteria, so the first genuine failure
// already decides the verdict. The commands run in PARALLEL and the first
// non-zero exit aborts the still-running siblings — a cheap structural check
// (e.g. an `rg` grep) that fails no longer has to wait out a multi-minute test
// suite running alongside it. An aborted sibling is "skipped" (status unknown),
// never counted as a failure of its own.

import { runShell, VERIFY_TIMEOUT_MS } from "./runShell.ts";
import type { GoalCheckStrategy, GoalContext } from "../../../core/src/ports/GoalCheckStrategy.ts";
import type { GoalSpec, GoalVerdict } from "../../../contracts/src/loop.ts";

export class DeterministicCommandStrategy implements GoalCheckStrategy {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  async evaluate(goal: GoalSpec, ctx: GoalContext): Promise<GoalVerdict> {
    // Resolve against the worker's worktree, else its checkout, else the repo root
    // (Fix 6a). Prefer the injected per-tick runner (shared with the collector so
    // hybrid runs each verify once, Fix 6b); fall back to runShell. Either way the
    // abort signal drives the fail-fast sibling-cancel.
    const cwd = ctx.worktreeDir ?? ctx.cwd ?? this.repoRoot;
    const abort = new AbortController();
    const run = (cmd: string): Promise<{ exitCode: number; output: string; aborted?: boolean }> =>
      ctx.runCommand ? ctx.runCommand.run(cmd, cwd, abort.signal) : runShell(cmd, cwd, VERIFY_TIMEOUT_MS, abort.signal);

    const checked = await Promise.all(
      goal.criteria.map(async (c) => {
        if (!c.verify) return { id: c.id, met: false, skipped: false, evidence: "no deterministic verify; needs judge" };
        ctx.progress?.({ phase: "verifying", criterionId: c.id });
        const r = await run(c.verify);
        if (r.aborted) return { id: c.id, met: false, skipped: true, evidence: "skipped: another criterion already failed" };
        const met = r.exitCode === 0;
        if (!met) abort.abort(); // first real failure cancels the remaining commands
        return { id: c.id, met, skipped: false, evidence: `exit ${r.exitCode}: ${c.verify}` };
      }),
    );

    const criteria: GoalVerdict["criteria"] = checked.map(({ id, met, evidence }) => ({ id, met, evidence }));
    // A skipped criterion's status is unknown, not failed — keep it out of `unmet`
    // (and the reason) so the worker only sees criteria actually proven unmet.
    const unmet = checked.filter((c) => !c.met && !c.skipped).map((c) => c.id);
    const met = checked.every((c) => c.met);
    return {
      met,
      criteria,
      unmet,
      confidence: 1,
      reason: met ? "all verify commands passed" : `unmet: ${unmet.join(", ")}`,
    };
  }
}
