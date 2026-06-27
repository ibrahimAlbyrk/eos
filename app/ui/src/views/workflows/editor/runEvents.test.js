import { describe, it, expect } from "vitest";
import { createRunState, parseChange, reduceRunEvent } from "./runEvents.js";

describe("runEvents (live SSE node highlighting)", () => {
  it("parses an SSE step-change payload", () => {
    const c = parseChange(JSON.stringify({
      reason: "workflow:step-change", ts: 1,
      payload: { runId: "r1", nodeId: "n1", status: "running" },
    }));
    expect(c.reason).toBe("workflow:step-change");
    expect(c.payload.nodeId).toBe("n1");
  });

  it("returns null on non-JSON / non-change data", () => {
    expect(parseChange("nope{")).toBeNull();
    expect(parseChange(123)).toBeNull();
    expect(parseChange(JSON.stringify({ ts: 1 }))).toBeNull();
  });

  it("updates a node's status from a step-change for the active run", () => {
    let s = createRunState("r1");
    s = reduceRunEvent(s, { reason: "workflow:step-change", payload: { runId: "r1", nodeId: "n1", status: "running" } });
    expect(s.nodeStates.n1).toBe("running");
    s = reduceRunEvent(s, { reason: "workflow:step-change", payload: { runId: "r1", nodeId: "n1", status: "passed" } });
    expect(s.nodeStates.n1).toBe("passed");
  });

  it("ignores events for a different run (same state reference)", () => {
    const s0 = createRunState("r1");
    const s1 = reduceRunEvent(s0, { reason: "workflow:step-change", payload: { runId: "OTHER", nodeId: "n1", status: "running" } });
    expect(s1).toBe(s0);
  });

  it("tracks the run-level status", () => {
    let s = createRunState("r1");
    s = reduceRunEvent(s, { reason: "workflow:run-change", payload: { runId: "r1", status: "passed" } });
    expect(s.runStatus).toBe("passed");
  });

  it("backfills from a seed (Runs view mid-run open) and keeps folding live", () => {
    let s = createRunState("r1", { runStatus: "running", nodeStates: { n1: "passed", n2: "running" } });
    expect(s.runStatus).toBe("running");
    expect(s.nodeStates).toEqual({ n1: "passed", n2: "running" });
    s = reduceRunEvent(s, { reason: "workflow:step-change", payload: { runId: "r1", nodeId: "n2", status: "passed" } });
    expect(s.nodeStates).toEqual({ n1: "passed", n2: "passed" });
  });
});
