import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

  it("resolves the verify cwd against ctx.cwd when there is no worktree (Fix 6a)", async () => {
    // A marker file exists only in this dir, not the strategy's repoRoot (tmpdir).
    const d = mkdtempSync(join(tmpdir(), "eos-detcwd-"));
    writeFileSync(join(d, "marker"), "x");
    const v = await strategy.evaluate(goal([{ id: "c1", text: "marker present", verify: "test -f marker" }]), { workerId: "w-1", attempt: 0, cwd: d });
    assert.equal(v.met, true); // test -f marker only passes when run in d
  });

  it("prefers ctx.runCommand over runShell, passing the abort signal through (Fix 6b)", async () => {
    const calls: string[] = [];
    let sawSignal = false;
    const runCommand = {
      run: async (cmd: string, _cwd: string, signal?: AbortSignal) => { calls.push(cmd); sawSignal = signal instanceof AbortSignal; return { exitCode: 0, output: "" }; },
    };
    const v = await strategy.evaluate(goal([{ id: "c1", text: "ok", verify: "exit 0" }]), { workerId: "w-1", attempt: 0, runCommand });
    assert.deepEqual(calls, ["exit 0"]);
    assert.equal(sawSignal, true);
    assert.equal(v.met, true);
  });

  it("a failing criterion aborts a still-running sibling instead of waiting it out", async () => {
    const started = Date.now();
    const v = await strategy.evaluate(
      goal([
        { id: "slow", text: "expensive suite", verify: "sleep 30" },
        { id: "cheap", text: "structural check", verify: "exit 1" },
      ]),
      ctx,
    );
    const elapsed = Date.now() - started;
    // The cheap failure must cancel the 30s sleep — not block on it.
    assert.ok(elapsed < 10_000, `expected fast abort, took ${elapsed}ms`);
    assert.equal(v.met, false);
    // Only the genuine failure is unmet; the aborted sibling is skipped, not failed.
    assert.deepEqual(v.unmet, ["cheap"]);
    const slow = v.criteria.find((c) => c.id === "slow");
    assert.match(slow!.evidence, /skipped/);
  });
});
