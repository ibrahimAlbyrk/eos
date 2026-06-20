import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeStrategyFor } from "../services/goal-strategy-registry.ts";
import type { GoalCheckStrategy } from "../ports/GoalCheckStrategy.ts";

const stub = (tag: string): GoalCheckStrategy => ({ evaluate: async () => ({ met: false, criteria: [], unmet: [], confidence: 0, reason: tag }) });

describe("makeStrategyFor", () => {
  it("resolves command, judge, and hybrid", () => {
    const strategyFor = makeStrategyFor({ command: stub("command"), judge: stub("judge"), hybrid: stub("hybrid") });
    assert.ok(strategyFor("command"));
    assert.ok(strategyFor("judge"));
    assert.ok(strategyFor("hybrid"));
  });

  it("throws a clear error for an unregistered strategy", () => {
    const strategyFor = makeStrategyFor({ command: stub("command") });
    assert.throws(() => strategyFor("judge"), /no goal-check strategy "judge"/);
  });
});
