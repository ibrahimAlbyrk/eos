import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { DeterministicCommandStrategy } from "../goalcheck/DeterministicCommandStrategy.ts";
import type { GoalContext } from "../../../core/src/ports/GoalCheckStrategy.ts";
import type { GoalSpec } from "../../../contracts/src/loop.ts";

const strategy = new DeterministicCommandStrategy(tmpdir());
const ctx: GoalContext = { workerId: "w-1", attempt: 0 };

function goal(criteria: GoalSpec["criteria"]): GoalSpec {
  return { summary: "s", criteria };
}

describe("DeterministicCommandStrategy", () => {
  it("verify exit 0 → criterion met, overall met", async () => {
    const v = await strategy.evaluate(goal([{ id: "c1", text: "ok", verify: "exit 0" }]), ctx);
    assert.equal(v.met, true);
    assert.equal(v.criteria[0].met, true);
    assert.deepEqual(v.unmet, []);
    assert.equal(v.confidence, 1);
  });

  it("verify non-zero exit → criterion unmet, overall unmet", async () => {
    const v = await strategy.evaluate(goal([{ id: "c1", text: "fails", verify: "exit 3" }]), ctx);
    assert.equal(v.met, false);
    assert.equal(v.criteria[0].met, false);
    assert.deepEqual(v.unmet, ["c1"]);
  });

  it("criterion with no verify → unmet, evidence flags it needs the judge", async () => {
    const v = await strategy.evaluate(goal([{ id: "c1", text: "subjective" }]), ctx);
    assert.equal(v.met, false);
    assert.equal(v.criteria[0].met, false);
    assert.match(v.criteria[0].evidence, /needs judge/);
  });

  it("overall met only when every criterion passes", async () => {
    const v = await strategy.evaluate(
      goal([
        { id: "c1", text: "ok", verify: "exit 0" },
        { id: "c2", text: "bad", verify: "exit 1" },
      ]),
      ctx,
    );
    assert.equal(v.met, false);
    assert.deepEqual(v.unmet, ["c2"]);
  });
});
