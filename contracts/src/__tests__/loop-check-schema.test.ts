import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopCheckProgressSchema, LoopCheckEventSchema } from "../loop.ts";
import { WorkerEventTypeSchema } from "../events.ts";

describe("LoopCheckProgressSchema (transient live progress)", () => {
  it("round-trips a started phase (no verdict fields)", () => {
    const p = { workerId: "w-1", attempt: 1, maxAttempts: 5, strategy: "hybrid", phase: "started" };
    const r = LoopCheckProgressSchema.safeParse(p);
    assert.ok(r.success);
    assert.deepEqual(r.data, p);
  });

  it("accepts a verifying phase with a criterionId", () => {
    const r = LoopCheckProgressSchema.safeParse({
      workerId: "w-1", attempt: 2, maxAttempts: null, strategy: "command", phase: "verifying", criterionId: "c1",
    });
    assert.ok(r.success);
    assert.equal(r.data.criterionId, "c1");
    assert.equal(r.data.maxAttempts, null);
  });

  it("accepts a verdict phase carrying met/outcome/reason", () => {
    const r = LoopCheckProgressSchema.safeParse({
      workerId: "w-1", attempt: 3, maxAttempts: 5, strategy: "judge", phase: "verdict",
      met: false, outcome: "continued", reason: "unmet: c1",
    });
    assert.ok(r.success);
    assert.deepEqual({ met: r.data.met, outcome: r.data.outcome }, { met: false, outcome: "continued" });
  });

  it("rejects an unknown phase / outcome / strategy", () => {
    const base = { workerId: "w-1", attempt: 1, maxAttempts: null, strategy: "hybrid", phase: "started" };
    assert.ok(!LoopCheckProgressSchema.safeParse({ ...base, phase: "running" }).success);
    assert.ok(!LoopCheckProgressSchema.safeParse({ ...base, strategy: "magic" }).success);
    assert.ok(!LoopCheckProgressSchema.safeParse({ ...base, phase: "verdict", outcome: "yeeted" }).success);
  });

  it("requires workerId so the UI can key the live indicator to a worker", () => {
    assert.ok(!LoopCheckProgressSchema.safeParse({ attempt: 1, maxAttempts: null, strategy: "hybrid", phase: "started" }).success);
  });
});

describe("LoopCheckEventSchema (persisted per-attempt verdict)", () => {
  it("round-trips a full verdict payload", () => {
    const e = { attempt: 2, maxAttempts: 5, strategy: "hybrid", met: false, outcome: "continued", reason: "unmet: c1" };
    const r = LoopCheckEventSchema.safeParse(e);
    assert.ok(r.success);
    assert.deepEqual(r.data, e);
  });

  it("requires met/outcome/reason (the durable record is never partial)", () => {
    assert.ok(!LoopCheckEventSchema.safeParse({ attempt: 1, maxAttempts: null, strategy: "judge" }).success);
  });
});

describe("loop_check timeline event", () => {
  it("is a registered worker event type", () => {
    assert.ok(WorkerEventTypeSchema.safeParse("loop_check").success);
  });
});
