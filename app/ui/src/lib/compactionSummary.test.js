import { describe, it, expect } from "vitest";
import { summarySections } from "./compactionSummary.js";

describe("summarySections", () => {
  it("splits the numbered sections and dedents their bodies", () => {
    const summary = [
      "1. Primary Request and Intent:",
      "   Move auth onto TokenService.",
      "",
      "2. Key Technical Concepts:",
      "   - JWT verify",
      "   - refresh families",
      "3. Pending Tasks: none",
    ].join("\n");
    expect(summarySections(summary)).toEqual([
      { title: "Primary Request and Intent", body: "Move auth onto TokenService." },
      { title: "Key Technical Concepts", body: "- JWT verify\n- refresh families" },
      { title: "Pending Tasks", body: "none" },
    ]);
  });

  it("never starts a section on a numbered item that breaks the count", () => {
    const summary = "1. Files and Code Sections:\n   1. auth.ts: the middleware\n2. Errors and fixes:\n   none";
    const s = summarySections(summary);
    expect(s.map((x) => x.title)).toEqual(["Files and Code Sections", "Errors and fixes"]);
    expect(s[0].body).toBe("1. auth.ts: the middleware");
  });

  it("keeps free-form text as one untitled section", () => {
    expect(summarySections("Just a paragraph.")).toEqual([{ title: null, body: "Just a paragraph." }]);
    expect(summarySections("")).toEqual([]);
  });
});
