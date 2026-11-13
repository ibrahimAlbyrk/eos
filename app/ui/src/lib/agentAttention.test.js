import { describe, it, expect } from "vitest";
import { sigOf, isStopped, needsAttention, syncViewed } from "./agentAttention.js";

const w = (state, { tokens_in = 0, tokens_out = 0, tool_calls = 0, cost_usd = 0 } = {}) =>
  ({ id: "w1", state, tokens_in, tokens_out, tool_calls, cost_usd });

describe("sigOf", () => {
  it("combines tokens, tool calls and cost", () => {
    expect(sigOf(w("IDLE", { tokens_in: 10, tokens_out: 5, tool_calls: 2, cost_usd: 0.3 }))).toBe("15|2|0.3");
  });

  it("treats missing counters as zero", () => {
    expect(sigOf({ id: "w1", state: "IDLE" })).toBe("0|0|0");
  });
});

describe("isStopped", () => {
  it.each(["IDLE", "DONE"])("%s is stopped", (s) => {
    expect(isStopped(s)).toBe(true);
  });

  it.each(["WORKING", "SPAWNING", "ENDING", "KILLING"])("%s is not stopped", (s) => {
    expect(isStopped(s)).toBe(false);
  });
});

describe("needsAttention", () => {
  const seenSig = sigOf(w("IDLE"));

  it("never flags a running agent, even with unseen output", () => {
    expect(needsAttention(seenSig, w("WORKING", { tokens_out: 100 }))).toBe(false);
    expect(needsAttention(seenSig, w("SPAWNING", { tokens_out: 100 }))).toBe(false);
  });

  it("flags a stopped agent with output since last view", () => {
    expect(needsAttention(seenSig, w("IDLE", { tokens_out: 100 }))).toBe(true);
    expect(needsAttention(seenSig, w("DONE", { tokens_out: 100 }))).toBe(true);
  });

  it("does not flag a stopped agent whose output was already viewed", () => {
    const worker = w("IDLE", { tokens_out: 100 });
    expect(needsAttention(sigOf(worker), worker)).toBe(false);
  });

  it("does not flag a never-seeded worker (app launch)", () => {
    expect(needsAttention(undefined, w("IDLE", { tokens_out: 100 }))).toBe(false);
  });

  it("does not flag a stop without new output", () => {
    expect(needsAttention(seenSig, w("IDLE"))).toBe(false);
  });

  it("handles null/malformed workers", () => {
    expect(needsAttention(seenSig, null)).toBe(false);
    expect(needsAttention(seenSig, {})).toBe(false);
  });
});

describe("syncViewed", () => {
  const row = (id, state, tokens_in = 0) => ({ id, state, tokens_in, tokens_out: 0, tool_calls: 0, cost_usd: 0 });

  it("seeds workers never seen", () => {
    const { next, visible } = syncViewed(new Map(), [row("a", "IDLE", 5)], null);
    expect(next.get("a")).toBe(sigOf(row("a", "IDLE", 5)));
    expect(visible).toBe(true);
  });

  it("tracks the selected worker while it runs without asking readers to re-render", () => {
    const prev = new Map([["a", sigOf(row("a", "WORKING", 1))]]);
    const { next, visible } = syncViewed(prev, [row("a", "WORKING", 2)], "a");
    expect(next.get("a")).toBe(sigOf(row("a", "WORKING", 2)));
    expect(visible).toBe(false);
  });

  it("re-renders readers once the selected worker stopped with new output", () => {
    const prev = new Map([["a", sigOf(row("a", "WORKING", 2))]]);
    const { visible } = syncViewed(prev, [row("a", "IDLE", 3)], "a");
    expect(visible).toBe(true);
  });

  it("leaves workers that are not shown alone, and drops the gone ones", () => {
    const prev = new Map([["a", "x"], ["gone", "y"]]);
    const { next, visible } = syncViewed(prev, [row("a", "IDLE", 9)], null);
    expect(next.get("a")).toBe("x");
    expect(next.has("gone")).toBe(false);
    expect(visible).toBe(false);
  });

  it("reports nothing when nothing changed", () => {
    const prev = new Map([["a", sigOf(row("a", "IDLE", 1))]]);
    expect(syncViewed(prev, [row("a", "IDLE", 1)], "a").next).toBeNull();
  });
});
