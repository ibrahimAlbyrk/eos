import { describe, it, expect } from "vitest";
import { markdownToHtml } from "./markdown.js";
import {
  codeSpanPath, collectPathRefs, displayParts, findPathCandidates, isLocalHref, locationLabel, parseLocation,
  resolvePath, withPathChips,
} from "./pathLinks.js";

describe("findPathCandidates", () => {
  const paths = (text) => findPathCandidates(text).map((c) => c.path);

  it("finds absolute, relative, ~ and bare file names", () => {
    expect(paths("⏺ Update(app/ui/src/a.js) and /Users/me/x ~/.claude/CLAUDE.md package.json"))
      .toEqual(["app/ui/src/a.js", "/Users/me/x", "~/.claude/CLAUDE.md", "package.json"]);
  });
  it("keeps a :line:col suffix in the link but not in the path", () => {
    expect(findPathCandidates("see src/a.ts:42:7.")).toEqual([{ index: 4, length: 13, path: "src/a.ts", line: 42, column: 7 }]);
  });
  it("reads a :line-endLine range", () => {
    expect(findPathCandidates("src/a.ts:42-47")).toEqual([{ index: 0, length: 14, path: "src/a.ts", line: 42, endLine: 47 }]);
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

describe("parseLocation / locationLabel", () => {
  it("splits line, column and range suffixes off the path", () => {
    expect(parseLocation("a.ts")).toEqual({ path: "a.ts" });
    expect(parseLocation("a.ts:42")).toEqual({ path: "a.ts", line: 42 });
    expect(parseLocation("a.ts:42:7")).toEqual({ path: "a.ts", line: 42, column: 7 });
    expect(parseLocation("a.ts:42–47")).toEqual({ path: "a.ts", line: 42, endLine: 47 });
  });
  it("labels them back", () => {
    expect(locationLabel({})).toBe("");
    expect(locationLabel({ line: 42 })).toBe(":42");
    expect(locationLabel({ line: 42, column: 7 })).toBe(":42:7");
    expect(locationLabel({ line: 42, endLine: 47 })).toBe(":42–47");
  });
});

describe("codeSpanPath", () => {
  it("reads paths, file:// URIs and @mentions", () => {
    expect(codeSpanPath("/private/tmp/x/guide.md")).toEqual({ path: "/private/tmp/x/guide.md" });
    expect(codeSpanPath("Assets/Editor/")).toEqual({ path: "Assets/Editor/" });
    expect(codeSpanPath("Movement.cs:42")).toEqual({ path: "Movement.cs", line: 42 });
    expect(codeSpanPath("file:///Users/me/My%20Shots/a.png")).toEqual({ path: "/Users/me/My Shots/a.png" });
    expect(codeSpanPath("@src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(codeSpanPath("app/[id]/page.tsx")).toEqual({ path: "app/[id]/page.tsx" });
  });
  it("allows spaces only in rooted paths", () => {
    expect(codeSpanPath("/Users/me/My Docs/a.md")).toEqual({ path: "/Users/me/My Docs/a.md" });
    expect(codeSpanPath("npm run build")).toBeNull();
  });
  it("rejects code, globs, URLs and bare words", () => {
    for (const s of ["ApplyGravity()", "src/**/*.ts", "https://a.com/b.js", "a = b/c", "27/10", "README", "{a}/b"]) {
      expect(codeSpanPath(s), s).toBeNull();
    }
  });
});

describe("displayParts", () => {
  const cwd = "/Users/me/repo";
  it("drops the agent's folder and writes home as ~", () => {
    expect(displayParts("/Users/me/repo/src/a.ts", { cwd })).toEqual({ dir: "src/", base: "a.ts" });
    expect(displayParts("/Users/me/.eos/config.json", { cwd })).toEqual({ dir: "~/.eos/", base: "config.json" });
  });
  it("folds a long middle, keeping the parent folder and the name", () => {
    const long = "/private/tmp/claude-501/-Users-me-Projects-x/91ddbca0-23be/scratchpad/unity-integration-guideline.md";
    expect(displayParts(long, { cwd })).toEqual({ dir: "…/scratchpad/", base: "unity-integration-guideline.md" });
  });
  it("marks a folder with a trailing slash", () => {
    expect(displayParts("Assets/Editor/", { type: "directory" })).toEqual({ dir: "Assets/", base: "Editor/" });
  });
  it("keeps the path as written when shortening is off", () => {
    expect(displayParts("/Users/me/repo/src/a.ts", { cwd, shorten: false })).toEqual({ dir: "/Users/me/repo/src/", base: "a.ts" });
  });
});

describe("isLocalHref", () => {
  it("tells disk links from web and in-page ones", () => {
    expect(isLocalHref("docs/setup.md")).toBe(true);
    expect(isLocalHref("/abs/a.md")).toBe(true);
    expect(isLocalHref("file:///a.md")).toBe(true);
    expect(isLocalHref("https://a.com")).toBe(false);
    expect(isLocalHref("mailto:a@b.co")).toBe(false);
    expect(isLocalHref("#top")).toBe(false);
    expect(isLocalHref(null)).toBe(false);
  });
});

describe("collectPathRefs", () => {
  const html = markdownToHtml([
    "Dosya: `/tmp/x/guide.md` ve `ApplyGravity()`",
    "Fix at src/a.ts:42 and [rehber](docs/setup.md), web [a](https://a.com/b.md).",
    "```",
    "src/inside-fence.ts",
    "```",
  ].join("\n"));

  it("finds code spans, prose and local links — never inside a code fence", () => {
    expect(collectPathRefs(html)).toEqual([
      { path: "/tmp/x/guide.md", from: "code" },
      { path: "src/a.ts", line: 42, from: "text" },
      { path: "docs/setup.md", from: "link" },
    ]);
  });
  it("skips prose text when plain-text paths are off", () => {
    expect(collectPathRefs(html, { plainText: false }).map((r) => r.path)).toEqual(["/tmp/x/guide.md", "docs/setup.md"]);
  });
  it("does not read a code span's text as prose", () => {
    expect(collectPathRefs(markdownToHtml("`npm i src/a.ts`"))).toEqual([]);
  });
});

describe("withPathChips", () => {
  const files = {
    "/tmp/x/guide.md": { abs: "/tmp/x/guide.md", type: "file" },
    "src/a.ts": { abs: "/repo/src/a.ts", type: "file" },
    "Assets/Editor/": { abs: "/repo/Assets/Editor", type: "directory" },
    "docs/setup.md": { abs: "/repo/docs/setup.md", type: "file" },
    "/gone/old.asset": { abs: "/gone/old.asset", missing: true },
    "lib/gone.ts": { abs: "/repo/lib/gone.ts", missing: true },
  };
  const lookup = (p) => files[p] ?? null;
  const render = (md, opts) => withPathChips(markdownToHtml(md), lookup, { cwd: "/repo", ...opts });

  it("turns an existing code-span path into a chip with its location", () => {
    const out = render("see `src/a.ts:42`");
    expect(out).toContain('<button type="button" class="path-chip" data-path="/repo/src/a.ts" data-type="file" data-line="42"');
    expect(out).toContain('<span class="path-chip-dir">src/</span><span class="path-chip-base">a.ts</span><span class="path-chip-loc">:42</span>');
    expect(out).not.toContain("<code>");
  });
  it("draws a folder chip", () => {
    expect(render("`Assets/Editor/`")).toContain('data-type="directory"');
    expect(render("`Assets/Editor/`")).toContain('<span class="path-chip-base">Editor/</span>');
  });
  it("links paths in prose and keeps the text around them", () => {
    const out = render("Fix at src/a.ts:42 & more.");
    expect(out).toMatch(/^<p>Fix at <button [^>]*data-path="\/repo\/src\/a\.ts"[^>]*>.*<\/button> &amp; more\.<\/p>/s);
  });
  it("marks a rooted missing path, leaves a relative one alone", () => {
    expect(render("`/gone/old.asset`")).toContain('<code class="path-missing" title="Not found">/gone/old.asset</code>');
    expect(render("`lib/gone.ts`")).toContain("<code>lib/gone.ts</code>");
  });
  it("gives a local link the path data and a glyph, keeping its text", () => {
    const out = render("[rehber](docs/setup.md)");
    expect(out).toMatch(/<a class="path-link" data-path="\/repo\/docs\/setup\.md" data-type="file" href="docs\/setup\.md"><svg class="path-link-icon"[^>]*>.*<\/svg>rehber<\/a>/s);
  });
  it("leaves unknown paths and code untouched", () => {
    const md = "`ApplyGravity()` and `other/x.ts`";
    expect(render(md)).toBe(markdownToHtml(md));
  });
  it("adds a native tooltip only when asked", () => {
    expect(render("`src/a.ts`")).not.toContain("title=");
    expect(render("`src/a.ts`", { title: true })).toContain('title="/repo/src/a.ts"');
  });
});
