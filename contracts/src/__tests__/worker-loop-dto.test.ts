import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkerRowSchema } from "../worker.ts";
import { SpawnWorkerRequestSchema } from "../http.ts";

const baseRow = {
  id: "w-1", state: "IDLE", cwd: "/x", worktree_from: null, branch: null,
  prompt: "p", name: null, pid: null, port: null, started_at: 1, ended_at: null, exit_code: null,
};

describe("WorkerRowSchema — route-enriched loop field", () => {
  it("parses a row carrying an active loop", () => {
    const r = WorkerRowSchema.parse({ ...baseRow, loop: { status: "active", attempt: 2, maxAttempts: 5, lastReason: "unmet: c1", goalSummary: "tests pass" } });
    assert.deepEqual(r.loop, { status: "active", attempt: 2, maxAttempts: 5, lastReason: "unmet: c1", goalSummary: "tests pass" });
  });

  it("loop is optional; maxAttempts + lastReason + goalSummary are nullable", () => {
    assert.equal(WorkerRowSchema.parse(baseRow).loop, undefined);
    const r = WorkerRowSchema.parse({ ...baseRow, loop: { status: "exhausted", attempt: 5, maxAttempts: null, lastReason: null, goalSummary: null } });
    assert.equal(r.loop?.maxAttempts, null);
    assert.equal(r.loop?.lastReason, null);
    assert.equal(r.loop?.goalSummary, null);
  });

  it("rejects an invalid loop status", () => {
    assert.throws(() => WorkerRowSchema.parse({ ...baseRow, loop: { status: "bogus", attempt: 1, maxAttempts: null, lastReason: null, goalSummary: null } }));
  });
});

describe("SpawnWorkerRequest — arm-at-spawn loop field", () => {
  it("accepts a spawn request carrying a loop (goal + optional strategy/limit)", () => {
    const r = SpawnWorkerRequestSchema.parse({
      prompt: "do the thing", cwd: "/repo",
      loop: { goal: { summary: "tests pass", criteria: [{ id: "c1", text: "green", verify: "npm test" }] }, strategy: "hybrid", limit: 5 },
    });
    assert.equal(r.loop?.goal.summary, "tests pass");
    assert.equal(r.loop?.strategy, "hybrid");
    assert.equal(r.loop?.limit, 5);
  });

  it("loop is optional and rejects an empty criteria list", () => {
    assert.equal(SpawnWorkerRequestSchema.parse({ prompt: "x", cwd: "/repo" }).loop, undefined);
    assert.throws(() => SpawnWorkerRequestSchema.parse({ prompt: "x", cwd: "/repo", loop: { goal: { summary: "s", criteria: [] } } }));
  });
});
