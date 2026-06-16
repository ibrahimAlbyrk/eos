import { describe, it, expect } from "vitest";
import { parseSkillBody, skillFilePath } from "./skillBody.js";

describe("skillFilePath", () => {
  it("appends SKILL.md to the base dir, null when absent", () => {
    expect(skillFilePath("/s/demo")).toBe("/s/demo/SKILL.md");
    expect(skillFilePath(null)).toBeNull();
    expect(skillFilePath(undefined)).toBeNull();
  });
});

describe("parseSkillBody", () => {
  it("extracts the base directory and strips its line", () => {
    const r = parseSkillBody("Base directory for this skill: /Users/x/.claude/skills/demo\n\n# Demo\nbody");
    expect(r).toEqual({ path: "/Users/x/.claude/skills/demo", body: "# Demo\nbody" });
  });

  it("returns null path when no base-directory line exists", () => {
    expect(parseSkillBody("# Demo\nbody")).toEqual({ path: null, body: "# Demo\nbody" });
  });

  it("strips frontmatter on either side of the base-dir line", () => {
    expect(parseSkillBody("---\nname: demo\n---\nBase directory for this skill: /s/demo\n\nbody"))
      .toEqual({ path: "/s/demo", body: "body" });
    expect(parseSkillBody("Base directory for this skill: /s/demo\n---\nname: demo\n---\nbody"))
      .toEqual({ path: "/s/demo", body: "body" });
  });

  it("handles empty and missing input", () => {
    expect(parseSkillBody(undefined)).toEqual({ path: null, body: "" });
    expect(parseSkillBody("")).toEqual({ path: null, body: "" });
  });
});
