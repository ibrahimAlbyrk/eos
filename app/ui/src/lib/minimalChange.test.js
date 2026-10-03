import { describe, it, expect } from "vitest";
import { minimalChange } from "./minimalChange.js";

const apply = (cur, c) => cur.slice(0, c.from) + c.insert + cur.slice(c.to);

describe("minimalChange", () => {
  it("replaces only the differing middle", () => {
    expect(minimalChange("git fetch --prune origin", "git fetch origin")).toEqual({ from: 10, to: 18, insert: "" });
    expect(minimalChange("abc", "aXc")).toEqual({ from: 1, to: 2, insert: "X" });
  });

  it("round-trips inserts, deletes and repeated characters", () => {
    for (const [cur, next] of [["", "new"], ["old", ""], ["aaa", "aaaa"], ["a\nb\n", "a\nc\nb\n"], ["same", "same"]]) {
      expect(apply(cur, minimalChange(cur, next))).toBe(next);
    }
  });
});
