import { describe, it, expect } from "vitest";
import { contextUsage } from "./contextWindow.js";

describe("contextUsage zero baseline", () => {
  it("fresh worker (no lastUsage, tokens_in undefined) yields used:0 pct:0", () => {
    const r = contextUsage({ model: "sonnet" }, "sonnet", null);
    expect(r.used).toBe(0);
    expect(r.pct).toBe(0);
    expect(r.total).toBe(200_000);
  });

  it("explicit tokens_in:0 with undefined lastUsage yields used:0 pct:0", () => {
    const r = contextUsage({ tokens_in: 0 }, "sonnet", undefined);
    expect(r.used).toBe(0);
    expect(r.pct).toBe(0);
  });
});
