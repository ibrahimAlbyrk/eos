import { describe, it, expect } from "vitest";
import { findBranchTokens, expandBranchRefs } from "./branchTokens.js";

const names = new Set(["main", "dev", "feature/x"]);

describe("findBranchTokens", () => {
  it("matches known branches at a trigger boundary", () => {
    expect(findBranchTokens("merge #dev into #main", names)).toEqual([
      { start: 6, end: 10, name: "dev" },
      { start: 16, end: 21, name: "main" },
    ]);
  });

  it("keeps slashes in branch names", () => {
    expect(findBranchTokens("#feature/x", names)).toEqual([{ start: 0, end: 10, name: "feature/x" }]);
  });

  it("drops trailing punctuation", () => {
    expect(findBranchTokens("see #dev, then #main.", names).map((t) => t.name)).toEqual(["dev", "main"]);
  });

  it("ignores unknown names, headings and mid-word #", () => {
    expect(findBranchTokens("# main", names)).toEqual([]);
    expect(findBranchTokens("#123 a#dev", names)).toEqual([]);
  });

  it("returns nothing without a branch list", () => {
    expect(findBranchTokens("#main", undefined)).toEqual([]);
    expect(findBranchTokens("#main", new Set())).toEqual([]);
  });
});

describe("expandBranchRefs", () => {
  it("spells branch references out for the agent", () => {
    expect(expandBranchRefs("rebase #dev onto #main.", names)).toBe(
      "rebase `dev` (git branch) onto `main` (git branch)."
    );
  });

  it("leaves text without references untouched", () => {
    expect(expandBranchRefs("fix #42", names)).toBe("fix #42");
  });
});
