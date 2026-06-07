import { describe, it, expect } from "vitest";
import { contextUsage, maxForModel } from "./contextWindow.js";
import { modelCtxTokens } from "./models.js";

describe("contextUsage zero baseline", () => {
  it("fresh worker (no lastUsage, tokens_in undefined) yields used:0 pct:0", () => {
    const r = contextUsage({ model: "sonnet" }, "sonnet", null);
    expect(r.used).toBe(0);
    expect(r.pct).toBe(0);
    expect(r.total).toBe(modelCtxTokens("sonnet"));
  });

  it("explicit tokens_in:0 with undefined lastUsage yields used:0 pct:0", () => {
    const r = contextUsage({ tokens_in: 0 }, "sonnet", undefined);
    expect(r.used).toBe(0);
    expect(r.pct).toBe(0);
  });
});

describe("maxForModel catalog delegation", () => {
  it("matches the catalog value the picker label derives from", () => {
    expect(maxForModel("sonnet")).toBe(modelCtxTokens("sonnet"));
    expect(maxForModel("opus")).toBe(modelCtxTokens("opus"));
  });

  it("falls back to 200k for unknown models", () => {
    expect(maxForModel("some-future-model")).toBe(200_000);
    expect(maxForModel(null)).toBe(200_000);
  });
});
