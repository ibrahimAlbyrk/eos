import { describe, it, expect } from "vitest";
import {
  isTerminalRunStatus, isActiveRunStatus, canStopRun,
  stepsToNodeStates, groupStepsByNode, findRunDefinition, resolveRunView,
  formatDuration, runDurationMs, stepDurationMs, applyRunChangeToList, sortRunsByRecency,
} from "./runsModel.js";

const step = (over) => ({ id: "s", runId: "r1", nodeId: "n1", nodeType: "worker", status: "passed", workerId: null, startedAt: 0, endedAt: null, ...over });

describe("runsModel — status predicates", () => {
  it("classifies terminal vs active statuses", () => {
    for (const t of ["passed", "failed", "stopped"]) expect(isTerminalRunStatus(t)).toBe(true);
    for (const a of ["pending", "running"]) { expect(isTerminalRunStatus(a)).toBe(false); expect(isActiveRunStatus(a)).toBe(true); }
    expect(isActiveRunStatus("passed")).toBe(false);
  });
  it("stops only non-terminal runs", () => {
    expect(canStopRun({ status: "running" })).toBe(true);
    expect(canStopRun({ status: "passed" })).toBe(false);
    expect(canStopRun(null)).toBe(false);
  });
});

describe("runsModel — steps → node states (canvas backfill)", () => {
  it("maps each node to its status", () => {
    const states = stepsToNodeStates([step({ nodeId: "a", status: "running" }), step({ nodeId: "b", status: "passed" })]);
    expect(states).toEqual({ a: "running", b: "passed" });
  });
  it("lets a later row for the same node win", () => {
    const states = stepsToNodeStates([step({ nodeId: "a", status: "running" }), step({ nodeId: "a", status: "failed" })]);
    expect(states.a).toBe("failed");
  });
  it("ignores malformed rows", () => {
    expect(stepsToNodeStates([null, {}, step({ nodeId: "a", status: "passed" })])).toEqual({ a: "passed" });
    expect(stepsToNodeStates(undefined)).toEqual({});
  });
});

describe("runsModel — group steps by node (side-list)", () => {
  it("groups preserving first-seen order and keeps every row", () => {
    const groups = groupStepsByNode([
      step({ nodeId: "a", status: "running" }),
      step({ nodeId: "b", status: "passed" }),
      step({ nodeId: "a", status: "passed" }),
    ]);
    expect(groups.map((g) => g.nodeId)).toEqual(["a", "b"]);
    expect(groups[0].steps).toHaveLength(2);
    expect(groups[0].nodeType).toBe("worker");
  });
});

describe("runsModel — graph vs step-list decision", () => {
  const v2 = { name: "wf", version: 2, nodes: [], edges: [] };
  const v1tree = { name: "wf", root: { type: "step" } };
  it("renders the canvas for a resolvable v2 graph", () => {
    const run = { definitionName: "wf" };
    expect(findRunDefinition([v2], run)).toBe(v2);
    expect(resolveRunView(run, v2)).toBe("graph");
  });
  it("falls back to the step list for a v1 tree definition", () => {
    expect(resolveRunView({ definitionName: "wf" }, v1tree)).toBe("steplist");
  });
  it("falls back for an inline run (null definitionName, no record)", () => {
    const run = { definitionName: null };
    expect(findRunDefinition([v2], run)).toBeNull();
    expect(resolveRunView(run, null)).toBe("steplist");
  });
});

describe("runsModel — elapsed formatting", () => {
  it("formats seconds / minutes / hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
  });
  it("guards missing / negative durations", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Infinity)).toBe("—");
  });
  it("freezes a terminal run at updatedAt and ticks an active run against now", () => {
    expect(runDurationMs({ status: "passed", startedAt: 1000, updatedAt: 4000 }, 999_999)).toBe(3000);
    expect(runDurationMs({ status: "running", startedAt: 1000, updatedAt: 1000 }, 6000)).toBe(5000);
    expect(runDurationMs(null, 0)).toBeNull();
  });
  it("freezes a settled step at endedAt and ticks an in-flight step against now", () => {
    expect(stepDurationMs(step({ startedAt: 100, endedAt: 700 }), 999)).toBe(600);
    expect(stepDurationMs(step({ startedAt: 100, endedAt: null }), 900)).toBe(800);
  });
});

describe("runsModel — live-merge run-change into the list", () => {
  const runs = [
    { id: "r1", status: "running", updatedAt: 2 },
    { id: "r2", status: "pending", updatedAt: 1 },
  ];
  it("flips the matching run's status", () => {
    const next = applyRunChangeToList(runs, { runId: "r1", status: "passed" });
    expect(next).not.toBe(runs);
    expect(next.find((r) => r.id === "r1").status).toBe("passed");
    expect(next.find((r) => r.id === "r2").status).toBe("pending");
  });
  it("returns the same reference when no run matches or status is unchanged", () => {
    expect(applyRunChangeToList(runs, { runId: "missing", status: "passed" })).toBe(runs);
    expect(applyRunChangeToList(runs, { runId: "r1", status: "running" })).toBe(runs);
    expect(applyRunChangeToList(runs, null)).toBe(runs);
  });
});

describe("runsModel — sort by recency", () => {
  it("orders most-recently-updated first", () => {
    const out = sortRunsByRecency([{ id: "a", updatedAt: 1 }, { id: "b", updatedAt: 3 }, { id: "c", startedAt: 2 }]);
    expect(out.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });
});
