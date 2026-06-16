import { describe, it, expect } from "vitest";
import { sigOf, isStopped, needsAttention } from "./agentAttention.js";

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
