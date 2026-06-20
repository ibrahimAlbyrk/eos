import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HybridStrategy } from "../services/HybridStrategy.ts";
import type { GoalSpec, GoalVerdict } from "../../../contracts/src/loop.ts";
import type { GoalCheckStrategy, GoalContext } from "../ports/GoalCheckStrategy.ts";

const CTX: GoalContext = { workerId: "w-1", attempt: 0 };
const GOAL: GoalSpec = { summary: "g", criteria: [{ id: "c1", text: "a", verify: "npm test" }, { id: "c2", text: "b" }] };

function fakeStrategy(verdict: GoalVerdict) {
  let calls = 0;
  const s: GoalCheckStrategy = { evaluate: async () => { calls++; return verdict; } };
  return { s, calls: () => calls };
}

function verdict(over: Partial<GoalVerdict>): GoalVerdict {
  return { met: false, criteria: [], unmet: [], confidence: 1, reason: "", ...over };
}

describe("HybridStrategy", () => {
  it("a failing verify command → return deterministic verdict, judge NOT called", async () => {
    const det = fakeStrategy(verdict({
      met: false,
      criteria: [{ id: "c1", met: false, evidence: "exit 1: npm test" }, { id: "c2", met: false, evidence: "needs judge" }],
      unmet: ["c1", "c2"],
    }));
    const judge = fakeStrategy(verdict({ met: true }));
    const v = await new HybridStrategy({ deterministic: det.s, judge: judge.s }).evaluate(GOAL, CTX);
    assert.equal(judge.calls(), 0);   // anti-gaming + cost: a red command short-circuits
    assert.equal(v.met, false);
  });

  it("all verify commands pass → judge IS called and owns the verdict", async () => {
    const det = fakeStrategy(verdict({
      met: false,   // c2 has no verify → deterministic can't pass it, but c1 passed
      criteria: [{ id: "c1", met: true, evidence: "exit 0: npm test" }, { id: "c2", met: false, evidence: "needs judge" }],
      unmet: ["c2"],
    }));
    const judge = fakeStrategy(verdict({ met: true, criteria: [{ id: "c1", met: true, evidence: "j" }, { id: "c2", met: true, evidence: "j" }], unmet: [] }));
    const v = await new HybridStrategy({ deterministic: det.s, judge: judge.s }).evaluate(GOAL, CTX);
    assert.equal(judge.calls(), 1);
    assert.equal(v.met, true);
  });
});
