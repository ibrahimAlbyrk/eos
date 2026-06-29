import { describe, it, expect } from "vitest";
import { skillNameFromRead } from "./skillName.js";

// cat -n formatted body, as Read results arrive in tool.result.text.
const cat = (lines) => lines.map((t, i) => `     ${i + 1}\t${t}`).join("\n");

describe("skillNameFromRead", () => {
  it("returns the frontmatter name for a SKILL.md read", () => {
    const text = cat(["---", "name: deep-research", "description: x", "---", "# Body"]);
    expect(skillNameFromRead("/s/foo/SKILL.md", text)).toBe("deep-research");
  });

  it("trims surrounding quotes around the name value", () => {
    const text = cat(["---", 'name: "video-reader"', "---"]);
    expect(skillNameFromRead("/s/foo/SKILL.md", text)).toBe("video-reader");
  });

  it("returns null when there is no frontmatter block", () => {
    expect(skillNameFromRead("/s/foo/SKILL.md", cat(["# Just a heading", "body"]))).toBeNull();
  });

  it("returns null when frontmatter has no name key", () => {
    const text = cat(["---", "description: only a description", "---", "# Body"]);
    expect(skillNameFromRead("/s/foo/SKILL.md", text)).toBeNull();
  });

  it("returns null for malformed (unterminated) frontmatter", () => {
    const text = cat(["---", "name: never-closes", "# Body without closing fence"]);
    expect(skillNameFromRead("/s/foo/SKILL.md", text)).toBeNull();
  });

  it("returns null for a non-SKILL.md path even with a name frontmatter", () => {
    const text = cat(["---", "name: not-a-skill", "---"]);
    expect(skillNameFromRead("/s/foo/README.md", text)).toBeNull();
  });

  it("returns null when there is no result yet", () => {
    expect(skillNameFromRead("/s/foo/SKILL.md", undefined)).toBeNull();
  });
});
