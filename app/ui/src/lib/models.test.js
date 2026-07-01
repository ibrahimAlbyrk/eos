import { describe, it, expect } from "vitest";
import { curateCatalog, applyCatalog, effortChoicesFor, EFFORTS, modelName, modelCtx, modelCtxTokens } from "./models.js";

// Shape mirrors what the daemon maps from GET /v1/models
const CATALOG = [
  { id: "claude-fable-5", displayName: "Claude Fable 5", createdAt: "2026-06-09T00:00:00Z", maxInputTokens: 1000000, maxTokens: 128000 },
  { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", createdAt: "2026-05-28T00:00:00Z", maxInputTokens: 1000000, maxTokens: 128000 },
  { id: "claude-opus-4-7", displayName: "Claude Opus 4.7", createdAt: "2026-04-14T00:00:00Z", maxInputTokens: 1000000, maxTokens: 128000 },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", createdAt: "2026-07-01T00:00:00Z", maxInputTokens: 1000000, maxTokens: 128000 },
  { id: "claude-sonnet-4-5-20250929", displayName: "Claude Sonnet 4.5", createdAt: "2025-09-29T00:00:00Z", maxInputTokens: 1000000, maxTokens: 64000 },
  { id: "claude-haiku-4-5-20251001", displayName: "Claude Haiku 4.5", createdAt: "2025-10-01T00:00:00Z", maxInputTokens: 200000, maxTokens: 64000 },
  { id: "claude-opus-4-20250514", displayName: "Claude Opus 4", createdAt: "2025-05-14T00:00:00Z", maxInputTokens: 200000, maxTokens: 32000 },
];

describe("curateCatalog", () => {
  it("picks the newest model per family in haiku/sonnet/opus/fable order", () => {
    const out = curateCatalog(CATALOG);
    expect(out.map((m) => m.id)).toEqual(["haiku-4.5", "sonnet-5", "opus-4.8", "fable-5"]);
  });

  it("derives display fields from API data", () => {
    const [haiku, sonnet, opus, fable] = curateCatalog(CATALOG);
    expect(haiku).toEqual({
      id: "haiku-4.5",
      aliases: ["haiku", "claude-haiku-4-5-20251001"],
      label: "haiku-4.5",
      name: "Haiku 4.5",
      ctxTokens: 200_000,
      efforts: null,
      tag: "fastest",
    });
    expect(sonnet.name).toBe("Sonnet 5");
    expect(sonnet.ctxTokens).toBe(1_000_000);
    expect(opus.aliases).toEqual(["opus", "claude-opus-4-8"]);
    expect(opus.tag).toBe("most capable");
    expect(fable).toEqual({
      id: "fable-5",
      aliases: ["fable", "claude-fable-5"],
      label: "fable-5",
      name: "Fable 5",
      ctxTokens: 1_000_000,
      efforts: null,
      tag: "most powerful",
    });
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
    expect(out.map((m) => m.id)).toEqual(["fable-5"]);
  });
});

describe("model helpers", () => {
  it("modelName resolves aliases and falls back to id parsing", () => {
    expect(modelName("opus")).toBe("Opus 4.8");
    expect(modelName("claude-sonnet-5")).toBe("Sonnet 5");
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

describe("effort capability", () => {
  it("curateCatalog carries effortLevels onto the curated entry", () => {
    const out = curateCatalog([
      { ...CATALOG[1], effortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { ...CATALOG[5], effortLevels: [] },
    ]);
    expect(out.find((m) => m.aliases.includes("opus")).efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(out.find((m) => m.aliases.includes("haiku")).efforts).toEqual([]);
  });

  it("shows all choices while capability is unknown (baseline)", () => {
    expect(effortChoicesFor("opus")).toEqual(EFFORTS);
    expect(effortChoicesFor("something-unknown")).toEqual(EFFORTS);
  });

  // Mutates module-level MODELS via applyCatalog — keep this test last.
  it("gates API levels by capability and hides the section for no-effort models", () => {
    applyCatalog([
      { ...CATALOG[2], effortLevels: ["low", "medium", "high", "max"] }, // opus-4.7, no xhigh
      { ...CATALOG[5], effortLevels: [] },
    ]);
    expect(effortChoicesFor("haiku")).toEqual([]);
    const opusIds = effortChoicesFor("opus").map((e) => e.id);
    expect(opusIds).not.toContain("xhigh");
    expect(opusIds).toEqual(["low", "medium", "high", "max", "ultracode"]);
  });
});
