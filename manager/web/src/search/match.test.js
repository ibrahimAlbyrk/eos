import { describe, it, expect } from "vitest";
import { scoreMatch } from "./match.js";

describe("scoreMatch", () => {
  it("returns 0 for empty query (keeps everything)", () => {
    expect(scoreMatch("", "anything")).toBe(0);
  });

  it("returns null when no characters match", () => {
    expect(scoreMatch("xyz", "agent")).toBeNull();
  });

  it("ranks substring matches above subsequence matches", () => {
    const substring = scoreMatch("orch", "orchestrator");
    const subsequence = scoreMatch("ohr", "orchestrator");
    expect(substring).toBeGreaterThan(subsequence);
  });

  it("ranks word-start matches above mid-word matches", () => {
    const wordStart = scoreMatch("test", "test runner");
    const midWord = scoreMatch("test", "latest build");
    expect(wordStart).toBeGreaterThan(midWord);
  });

  it("is case-insensitive", () => {
    expect(scoreMatch("AGENT", "agent")).toBe(scoreMatch("agent", "agent"));
  });

  it("matches out-of-order subsequences", () => {
    expect(scoreMatch("sel", "Selam")).not.toBeNull();
  });
});
