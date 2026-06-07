import { describe, it, expect } from "vitest";
import { curateCatalog, modelName, modelCtx, modelCtxTokens } from "./models.js";

// Shape mirrors what the daemon maps from GET /v1/models
const CATALOG = [
  { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", createdAt: "2026-05-28T00:00:00Z", maxInputTokens: 1000000, maxTokens: 128000 },
  { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", createdAt: "2026-04-14T00:00:00Z", maxInputTokens: 1000000, maxTokens: 128000 },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", createdAt: "2026-02-17T00:00:00Z", maxInputTokens: 1000000, maxTokens: 128000 },
  { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5", createdAt: "2025-09-29T00:00:00Z", maxInputTokens: 1000000, maxTokens: 64000 },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", createdAt: "2025-10-01T00:00:00Z", maxInputTokens: 200000, maxTokens: 64000 },
  { id: "claude-opus-4-20250514", displayName: "Claude Opus 4", createdAt: "2025-05-14T00:00:00Z", maxInputTokens: 200000, maxTokens: 32000 },
];

describe("curateCatalog", () => {
  it("picks the newest model per family in haiku/sonnet/opus order", () => {
    const out = curateCatalog(CATALOG);
    expect(out.map((m) => m.id)).toEqual(["haiku-4.5", "sonnet-4.6", "opus-4.8"]);
  });

  it("derives display fields from API data", () => {
    const [haiku, sonnet, opus] = curateCatalog(CATALOG);
    expect(haiku).toEqual({
      id: "haiku-4.5",
      aliases: ["haiku", "claude-haiku-4-5-20251001"],
      label: "haiku-4.5",
      name: "Haiku 4.5",
      ctxTokens: 200_000,
      tag: "fastest",
    });
    expect(sonnet.name).toBe("Sonnet 4.6");
    expect(sonnet.ctxTokens).toBe(1_000_000);
    expect(opus.aliases).toEqual(["opus", "claude-opus-4-8"]);
    expect(opus.tag).toBe("most capable");
  });

  it("strips date suffixes from dated ids", () => {
    const out = curateCatalog([
      { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5", createdAt: "2025-09-29T00:00:00Z", maxInputTokens: 1000000 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("sonnet-4.5");
  });

  it("returns empty for missing or malformed input", () => {
    expect(curateCatalog(null)).toEqual([]);
    expect(curateCatalog([])).toEqual([]);
    expect(curateCatalog([{ nope: true }])).toEqual([]);
  });

  it("tolerates a partial catalog", () => {
    const out = curateCatalog([CATALOG[0]]);
    expect(out.map((m) => m.id)).toEqual(["opus-4.8"]);
  });
});

describe("model helpers", () => {
  it("modelName resolves aliases and falls back to id parsing", () => {
    expect(modelName("opus")).toBe("Opus 4.8");
    expect(modelName("claude-sonnet-4-6")).toBe("Sonnet 4.6");
  });

  it("modelCtx resolves known models", () => {
    expect(modelCtx("opus")).toBe("1M");
    expect(modelCtx("unknown-model")).toBe(null);
  });

  it("modelCtxTokens resolves aliases and family substrings", () => {
    expect(modelCtxTokens("sonnet")).toBe(1_000_000);
    expect(modelCtxTokens("claude-haiku-4-5-20251001")).toBe(200_000);
    expect(modelCtxTokens("unknown-model")).toBe(null);
  });
});
