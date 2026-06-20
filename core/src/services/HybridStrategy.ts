// HybridStrategy — deterministic first, judge second. A criterion with a verify
// command that FAILS is a hard, citable failure: return the deterministic
// verdict and do NOT pay for (or risk gaming) the judge. Only when every
// verify-backed criterion passes (or the goal has none) do we call the judge to
// grade the subjective criteria. Composes two GoalCheckStrategy instances.

import type { GoalSpec, GoalVerdict } from "../../../contracts/src/loop.ts";
import type { GoalCheckStrategy, GoalContext } from "../ports/GoalCheckStrategy.ts";

export interface HybridStrategyDeps {
  deterministic: GoalCheckStrategy;
  judge: GoalCheckStrategy;
}

export class HybridStrategy implements GoalCheckStrategy {
  private readonly deps: HybridStrategyDeps;

  constructor(deps: HybridStrategyDeps) {
    this.deps = deps;
  }

  async evaluate(goal: GoalSpec, ctx: GoalContext): Promise<GoalVerdict> {
    const det = await this.deps.deterministic.evaluate(goal, ctx);

    // A real verify command that failed → hard unmet. Don't call the judge: it's
    // a wasted cost, and a passing-tone claim must not override a red command.
    const detMet = new Map(det.criteria.map((c) => [c.id, c.met]));
    const hardFailure = goal.criteria.some((c) => c.verify && detMet.get(c.id) === false);
    if (hardFailure) return det;

    // Every verify-backed criterion passed (or there were none) → the judge owns
    // the verdict (it re-checks the subjective / no-verify criteria over artifacts).
    return this.deps.judge.evaluate(goal, ctx);
  }
}
