// Goal-check strategy registry — name → strategy lookup. An unknown name throws
// a clear error (a loop attached with an unregistered strategy stays inert,
// logged by the gate, rather than silently passing). Pure, so the container's
// wiring is verified without standing up the whole container.

import type { GoalCheckStrategy } from "../ports/GoalCheckStrategy.ts";

export function makeStrategyFor(
  strategies: Record<string, GoalCheckStrategy>,
): (name: string) => GoalCheckStrategy {
  return (name: string): GoalCheckStrategy => {
    const s = strategies[name];
    if (!s) throw new Error(`no goal-check strategy "${name}" (supported: ${Object.keys(strategies).join(", ")})`);
    return s;
  };
}
