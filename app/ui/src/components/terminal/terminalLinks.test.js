import { describe, it, expect } from "vitest";
import { findPathCandidates, resolvePath, resolveTerminalLink } from "./terminalLinks.js";

describe("resolveTerminalLink", () => {
  it("resolves web links", () => {
    expect(resolveTerminalLink("https://example.com/a?b=1")).toEqual({ kind: "web", url: "https://example.com/a?b=1" });
    expect(resolveTerminalLink("mailto:a@b.co")).toEqual({ kind: "web", url: "mailto:a@b.co" });
  });
  it("resolves file links to a decoded absolute path", () => {
    expect(resolveTerminalLink("file:///Users/me/My%20Dir/a.ts")).toEqual({ kind: "file", path: "/Users/me/My Dir/a.ts" });
  });
  it("rejects other schemes and junk", () => {
    expect(resolveTerminalLink("javascript:alert(1)")).toBeNull();
    expect(resolveTerminalLink("not a url")).toBeNull();
  });
});

describe("findPathCandidates", () => {
  const paths = (text) => findPathCandidates(text).map((c) => c.path);

  it("finds absolute, relative, ~ and bare file names", () => {
    expect(paths("⏺ Update(app/ui/src/a.js) and /Users/me/x ~/.claude/CLAUDE.md package.json"))
      .toEqual(["app/ui/src/a.js", "/Users/me/x", "~/.claude/CLAUDE.md", "package.json"]);
  });
  it("keeps a :line:col suffix in the link but not in the path", () => {
    expect(findPathCandidates("see src/a.ts:42:7.")).toEqual([{ index: 4, length: 13, path: "src/a.ts" }]);
  });
  it("strips @ mentions and sentence periods from the link", () => {
    expect(findPathCandidates("@src/a.ts.")).toEqual([{ index: 1, length: 8, path: "src/a.ts" }]);
  });
  it("matches non-ASCII names", () => {
    expect(paths("dosyalar/çalışma.md")).toEqual(["dosyalar/çalışma.md"]);
  });
  it("skips plain words, numbers and URL hosts", () => {
    expect(paths("hello world 1.5 ... https://example.com/a/b.js")).toEqual([]);
  });
});

describe("resolvePath", () => {
  it("resolves relative paths against the cwd and normalizes", () => {
    expect(resolvePath("src/../lib/./a.js", "/repo")).toBe("/repo/lib/a.js");
    expect(resolvePath("/abs/a.js", null)).toBe("/abs/a.js");
  });
  it("expands ~ from the cwd's home folder", () => {
    expect(resolvePath("~/.claude/x.md", "/Users/me/repo")).toBe("/Users/me/.claude/x.md");
    expect(resolvePath("~/x.md", "/opt/repo")).toBeNull();
  });
  it("can't resolve a relative path without a cwd", () => {
    expect(resolvePath("src/a.js", undefined)).toBeNull();
  });
});
