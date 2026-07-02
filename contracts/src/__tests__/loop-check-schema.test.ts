import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopCheckProgressSchema, LoopCheckEventSchema, GoalVerdictSchema } from "../loop.ts";
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

  it("accepts the escalated outcome in both the event and the live progress payload", () => {
    const e = { attempt: 2, maxAttempts: null, strategy: "judge", met: false, outcome: "escalated", reason: "gate cannot verify c2" };
    assert.ok(LoopCheckEventSchema.safeParse(e).success);
    assert.ok(LoopCheckProgressSchema.safeParse({ workerId: "w-1", phase: "verdict", ...e }).success);
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

describe("GoalVerdictSchema — unverifiable lane", () => {
  const base = { met: false, unmet: ["c1"], confidence: 0.5, reason: "r" };

  it("round-trips a verdict with an unverifiable met:false criterion", () => {
    const v = { ...base, criteria: [{ id: "c1", met: false, evidence: "no check exists", unverifiable: true }] };
    const r = GoalVerdictSchema.safeParse(v);
    assert.ok(r.success);
    assert.deepEqual(r.data, v);
  });

  it("unverifiable is optional — a criterion without it still parses", () => {
    const r = GoalVerdictSchema.safeParse({ ...base, criteria: [{ id: "c1", met: false, evidence: "exit 1" }] });
    assert.ok(r.success);
    assert.equal(r.data.criteria[0].unverifiable, undefined);
  });

  it("rejects a non-boolean unverifiable", () => {
    assert.ok(!GoalVerdictSchema.safeParse({ ...base, criteria: [{ id: "c1", met: false, evidence: "x", unverifiable: "yes" }] }).success);
  });
});
