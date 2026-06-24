// DeterministicCommandStrategy — runs each criterion's `verify` shell command;
// exit 0 = met. A criterion with no verify command is unmet ("needs judge") —
// the LLM judge owns those. Overall met = every criterion met. Thin: no state,
// no parsing — just exit codes turned into a GoalVerdict.

import { runShell, VERIFY_TIMEOUT_MS } from "./runShell.ts";
import type { GoalCheckStrategy, GoalContext } from "../../../core/src/ports/GoalCheckStrategy.ts";
import type { GoalSpec, GoalVerdict } from "../../../contracts/src/loop.ts";

export class DeterministicCommandStrategy implements GoalCheckStrategy {
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  async evaluate(goal: GoalSpec, ctx: GoalContext): Promise<GoalVerdict> {
    const cwd = ctx.worktreeDir ?? this.repoRoot;
    const criteria: GoalVerdict["criteria"] = [];
    for (const c of goal.criteria) {
      if (!c.verify) {
        criteria.push({ id: c.id, met: false, evidence: "no deterministic verify; needs judge" });
        continue;
      }
      ctx.progress?.({ phase: "verifying", criterionId: c.id });
      const r = await runShell(c.verify, cwd, VERIFY_TIMEOUT_MS);
      criteria.push({ id: c.id, met: r.exitCode === 0, evidence: `exit ${r.exitCode}: ${c.verify}` });
    }
    const unmet = criteria.filter((c) => !c.met).map((c) => c.id);
    const met = unmet.length === 0;
    return {
      met,
      criteria,
      unmet,
      confidence: 1,
      reason: met ? "all verify commands passed" : `unmet: ${unmet.join(", ")}`,
    };
  }
}
