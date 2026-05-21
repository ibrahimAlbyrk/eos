import { describe, it, expect } from "vitest";
import { fmtCost, fmtElapsed, modelShort, ctxPct, toolIcon, stripMcpPrefix } from "../format.js";

describe("fmtCost", () => {
  it("uses 3 decimals under $1, 2 above", () => {
    expect(fmtCost(0.123)).toBe("$0.123");
    expect(fmtCost(1.23456)).toBe("$1.23");
    expect(fmtCost(0)).toBe("$0.000");
  });
  it("treats null/undefined as 0", () => {
    expect(fmtCost(null)).toBe("$0.000");
    expect(fmtCost(undefined)).toBe("$0.000");
  });
});

describe("fmtElapsed", () => {
  it("returns dash for falsy/negative", () => {
    expect(fmtElapsed(0)).toBe("—");
    expect(fmtElapsed(-1)).toBe("—");
    expect(fmtElapsed(null)).toBe("—");
  });
  it("MM:SS under an hour", () => {
    expect(fmtElapsed(65_000)).toBe("01:05");
    expect(fmtElapsed(59_999)).toBe("00:59");
  });
  it("HH:MM:SS at/over an hour", () => {
    expect(fmtElapsed(3_661_000)).toBe("01:01:01");
  });
});

describe("modelShort", () => {
  it("strips claude- prefix", () => {
    expect(modelShort("claude-opus-4.5")).toBe("opus-4.5");
    expect(modelShort("claude-sonnet-4.5")).toBe("sonnet-4.5");
  });
  it("passes through unfamiliar strings", () => {
    expect(modelShort("opus")).toBe("opus");
    expect(modelShort("")).toBe("—");
    expect(modelShort(null)).toBe("—");
  });
});

describe("ctxPct", () => {
  it("computes percentage of budget", () => {
    expect(ctxPct({ tokens: { in: 1000, out: 1000, budget: 10_000 } })).toBe(20);
  });
  it("clamps at 100", () => {
    expect(ctxPct({ tokens: { in: 1_000_000, out: 0, budget: 10_000 } })).toBe(100);
  });
  it("uses 200k default budget when missing", () => {
    expect(ctxPct({ tokens: { in: 20_000, out: 0 } })).toBe(10);
    expect(ctxPct({})).toBe(0);
  });
});

describe("toolIcon", () => {
  it("maps known tool families", () => {
    expect(toolIcon("Read")).toBe("read");
    expect(toolIcon("Edit")).toBe("edit");
    expect(toolIcon("MultiEdit")).toBe("edit");
    expect(toolIcon("Write")).toBe("filePlus");
    expect(toolIcon("Bash")).toBe("terminal");
    expect(toolIcon("Grep")).toBe("grep");
    expect(toolIcon("WebFetch")).toBe("globe");
    expect(toolIcon("Task")).toBe("agentSpawn");
    expect(toolIcon("TodoWrite")).toBe("checkSquare");
    expect(toolIcon("ExitPlanMode")).toBe("scroll");
    expect(toolIcon("mcp__orchestrator__spawn_worker")).toBe("spawn");
  });
  it("falls back to tool icon", () => {
    expect(toolIcon("Unknown")).toBe("tool");
    expect(toolIcon(null)).toBe("tool");
    expect(toolIcon("")).toBe("tool");
  });
});

describe("stripMcpPrefix", () => {
  it("removes mcp__<server>__ prefix", () => {
    expect(stripMcpPrefix("mcp__orchestrator__spawn_worker")).toBe("spawn_worker");
    expect(stripMcpPrefix("mcp__gateway__decide")).toBe("decide");
  });
  it("leaves non-MCP names alone", () => {
    expect(stripMcpPrefix("Bash")).toBe("Bash");
    expect(stripMcpPrefix("")).toBe("tool"); // default fallback
    expect(stripMcpPrefix(null)).toBe("tool");
  });
});
