import { describe, it, expect } from "vitest";
import { contextUsage, maxForModel } from "./contextWindow.js";
import { modelCtxTokens } from "./models.js";

describe("contextUsage", () => {
  it("fresh worker (last_context_tokens unset) yields used:0 pct:0", () => {
    const r = contextUsage({ model: "sonnet" }, "sonnet");
    expect(r.used).toBe(0);
    expect(r.pct).toBe(0);
    expect(r.total).toBe(modelCtxTokens("sonnet"));
  });

  it("reads last_context_tokens from the worker row", () => {
    const total = modelCtxTokens("sonnet");
    const r = contextUsage({ last_context_tokens: 134000 }, "sonnet");
    expect(r.used).toBe(134000);
    expect(r.pct).toBe(Math.round((134000 / total) * 100));
  });

  it("ignores cumulative tokens_in — it is not a context measure", () => {
    const r = contextUsage({ tokens_in: 56, last_context_tokens: null }, "sonnet");
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
