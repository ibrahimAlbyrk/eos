// Attach/amend-time lint over a goal against its strategy — the single authoring
// chokepoint both attachLoop and amendLoop funnel through, so a goal an amend
// smuggles in gets the same structural checks attach would apply. A "command"
// goal with any verify-less criterion is structurally unpassable (the command
// gate skips verify-less criteria) → reject. For "judge"/"hybrid" a verify-less
// criterion naming no file path is legitimate but can only be graded over
// diff+files → advisory warning, never a rejection.

import { ValidationError } from "../errors/index.ts";
import type { GoalSpec, LoopStrategy } from "../../../contracts/src/loop.ts";

// A criterion carries no runnable proof if its verify command is missing/blank.
function isVerifyless(criterion: GoalSpec["criteria"][number]): boolean {
  return !criterion.verify || criterion.verify.trim() === "";
}

// Does the criterion text reference a concrete file the judge could grade from
// the collected diff + files — a slash path (src/game.ts) or a dotted filename
// (index.html)? A route (/health) or plain prose names no such artifact.
const PATH_TOKEN = /[\w.-]+\/[\w./-]+|\b[\w-]+\.[A-Za-z][\w-]*\b/;

// Throws ValidationError on a structurally-unpassable goal; otherwise returns the
// advisory warnings (possibly empty).
export function lintGoalCriteria(strategy: LoopStrategy, goal: GoalSpec): string[] {
  const verifyless = goal.criteria.filter(isVerifyless);
  if (strategy === "command" && verifyless.length > 0) {
    const ids = verifyless.map((c) => c.id).join(", ");
    throw new ValidationError(
      `strategy "command" needs a verify on every criterion; ${ids} ` +
        `${verifyless.length === 1 ? "has" : "have"} none — the command gate skips ` +
        "verify-less criteria, so this goal can never pass",
    );
  }
  if (strategy !== "judge" && strategy !== "hybrid") return [];
  return verifyless
    .filter((c) => !PATH_TOKEN.test(c.text))
    .map(
      (c) =>
        `criterion "${c.id}" has no verify and names no file path — the judge sees only ` +
        "the diff and named files for it and may never confirm runtime behavior; add a verify " +
        "(smoke command) or name the artifact it produces",
    );
}
