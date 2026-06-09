import { describe, it, expect } from "vitest";
import { hasUnintegratedWork, isRowRelevant } from "./workState.js";

describe("hasUnintegratedWork", () => {
  it("is false for null/zero diffs", () => {
    expect(hasUnintegratedWork(null)).toBe(false);
    expect(hasUnintegratedWork({ insertions: 0, deletions: 0, files: 0 })).toBe(false);
  });

  it("is true when any counter is positive", () => {
    expect(hasUnintegratedWork({ insertions: 1, deletions: 0, files: 0 })).toBe(true);
    expect(hasUnintegratedWork({ insertions: 0, deletions: 2, files: 0 })).toBe(true);
    expect(hasUnintegratedWork({ insertions: 0, deletions: 0, files: 1 })).toBe(true);
  });
});

describe("isRowRelevant", () => {
  it("is false for a clean, synced repo with no verdict", () => {
    expect(isRowRelevant({ diff: { insertions: 0, deletions: 0, files: 0 } })).toBe(false);
    expect(isRowRelevant({})).toBe(false);
  });

  it("each signal alone makes the row relevant", () => {
    expect(isRowRelevant({ diff: { insertions: 1, deletions: 0, files: 0 } })).toBe(true);
    expect(isRowRelevant({ ahead: 1 })).toBe(true);
    expect(isRowRelevant({ behind: 2 })).toBe(true);
    expect(isRowRelevant({ stash: 1 })).toBe(true);
    expect(isRowRelevant({ conflicts: 1 })).toBe(true);
    expect(isRowRelevant({ verdict: { verdict: "passed" } })).toBe(true);
  });
});
