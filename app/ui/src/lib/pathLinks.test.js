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

describe("Windows paths", () => {
  const cwd = "C:\\Users\\me\\repo";
  const paths = (text, opts) => findPathCandidates(text, opts).map((c) => c.path);

  it("finds drive and UNC paths whatever the agent's folder", () => {
    expect(paths("open C:\\Users\\me\\a.ts or C:/Users/me/b.ts and \\\\server\\share\\c.txt"))
      .toEqual(["C:\\Users\\me\\a.ts", "C:/Users/me/b.ts", "\\\\server\\share\\c.txt"]);
  });
  it("finds backslash-relative paths only under a Windows folder", () => {
    expect(paths("src\\lib\\a.ts .\\b.ts ..\\c.md", { cwd })).toEqual(["src\\lib\\a.ts", ".\\b.ts", "..\\c.md"]);
    expect(paths("cat My\\ Docs/a.md", { cwd: "/Users/me" })).toEqual(["Docs/a.md"]);
  });
  it("reads a :line[:col] or range after a drive path, never the drive colon", () => {
    expect(findPathCandidates("at C:\\repo\\a.ts:12:3.")).toEqual([{ index: 3, length: 17, path: "C:\\repo\\a.ts", line: 12, column: 3 }]);
    expect(findPathCandidates("src\\a.ts:4-9", { cwd })).toEqual([{ index: 0, length: 12, path: "src\\a.ts", line: 4, endLine: 9 }]);
    expect(codeSpanPath("C:\\repo\\a.ts:12")).toEqual({ path: "C:\\repo\\a.ts", line: 12 });
  });
  it("skips a bare drive, colons in prose and URLs", () => {
    for (const opts of [{}, { cwd }]) {
      expect(paths("C: and C:\\ and a:b, ratio 3:4, https://x/y and \\\\server", opts)).toEqual([]);
    }
  });

  it("resolves against a Windows folder with Windows semantics, always with backslashes", () => {
    expect(resolvePath("src\\..\\lib\\.\\a.ts", cwd)).toBe("C:\\Users\\me\\repo\\lib\\a.ts");
    expect(resolvePath("src/a.ts", cwd)).toBe("C:\\Users\\me\\repo\\src\\a.ts");
    expect(resolvePath(".\\a.ts", cwd)).toBe("C:\\Users\\me\\repo\\a.ts");
    expect(resolvePath("..\\a.ts", cwd)).toBe("C:\\Users\\me\\a.ts");
    expect(resolvePath("c:/Repo/x/../a.ts", null)).toBe("C:\\Repo\\a.ts");
    expect(resolvePath("\\tmp\\a.ts", cwd)).toBe("C:\\tmp\\a.ts");
    expect(resolvePath("~/.claude/x.md", cwd)).toBe("C:\\Users\\me\\.claude\\x.md");
    expect(resolvePath("a.txt", "\\\\server\\share\\dir")).toBe("\\\\server\\share\\dir\\a.txt");
    expect(resolvePath("..\\..\\..\\a.ts", "D:\\x")).toBe("D:\\a.ts");
    expect(resolvePath("C:\\", null)).toBe("C:\\");
  });
  it("can't resolve a Windows-relative path without a Windows folder", () => {
    expect(resolvePath("src\\a.ts", undefined)).toBeNull();
    expect(resolvePath("~/x.md", "D:\\work")).toBeNull();
  });

  it("reads code spans, file:// URIs and encoded link targets", () => {
    expect(codeSpanPath("C:\\Program Files\\App\\a.dll")).toEqual({ path: "C:\\Program Files\\App\\a.dll" });
    expect(codeSpanPath("\\\\srv\\share\\a.txt")).toEqual({ path: "\\\\srv\\share\\a.txt" });
    expect(codeSpanPath("src\\lib\\a.ts", { cwd })).toEqual({ path: "src\\lib\\a.ts" });
    expect(codeSpanPath("file:///C:/My%20Docs/a.md")).toEqual({ path: "C:/My Docs/a.md" });
    expect(codeSpanPath("file://srv/share/a.txt", { cwd })).toEqual({ path: "\\\\srv\\share\\a.txt" });
    expect(codeSpanPath("C:%5Crepo%5Ca.ts")).toEqual({ path: "C:\\repo\\a.ts" });
  });
  it("rejects a bare drive, a lone server and backslashes outside Windows paths", () => {
    for (const s of ["C:", "C:\\", "C:12", "\\\\server", "a:b", "src\\a.ts", "npm run C:\\x"]) {
      expect(codeSpanPath(s), s).toBeNull();
    }
    expect(codeSpanPath("src\\a b.ts", { cwd })).toBeNull();
  });
  it("treats drive links as local", () => {
    expect(isLocalHref("C:/x/a.md")).toBe(true);
    expect(isLocalHref("C:%5Cx%5Ca.md")).toBe(true);
    expect(isLocalHref("c:")).toBe(false);
  });

  it("displays with the agent's folder dropped and home as ~, either separator", () => {
    expect(displayParts("C:\\Users\\me\\repo\\src\\a.ts", { cwd })).toEqual({ dir: "src\\", base: "a.ts" });
    expect(displayParts("c:/users/me/repo/src/a.ts", { cwd })).toEqual({ dir: "src/", base: "a.ts" });
    expect(displayParts("C:\\Users\\me\\.eos\\config.json", { cwd })).toEqual({ dir: "~\\.eos\\", base: "config.json" });
    expect(displayParts("Assets\\Editor\\", { cwd, type: "directory" })).toEqual({ dir: "Assets\\", base: "Editor\\" });
    expect(displayParts("C:\\Users\\me\\repo\\src\\a.ts", { cwd, shorten: false })).toEqual({ dir: "C:\\Users\\me\\repo\\src\\", base: "a.ts" });
    const long = "D:\\tmp\\claude-501\\-Users-me-Projects-x\\91ddbca0-23be\\scratchpad\\unity-integration-guideline.md";
    expect(displayParts(long, { cwd })).toEqual({ dir: "…\\scratchpad\\", base: "unity-integration-guideline.md" });
  });

  it("collects and chips Windows paths in prose against a Windows folder", () => {
    const html = markdownToHtml("See `C:\\repo\\a.ts:12`, src\\b.ts and [c](C:\\repo\\c.md).");
    expect(collectPathRefs(html, { cwd: "C:\\repo" })).toEqual([
      { path: "C:\\repo\\a.ts", line: 12, from: "code" },
      { path: "src\\b.ts", from: "text" },
      { path: "C:\\repo\\c.md", from: "link" },
    ]);
    const files = {
      "C:\\repo\\a.ts": { abs: "C:\\repo\\a.ts", type: "file" },
      "src\\b.ts": { abs: "C:\\repo\\src\\b.ts", type: "file" },
      "C:\\gone.ts": { abs: "C:\\gone.ts", missing: true },
    };
    const out = withPathChips(html, (p) => files[p] ?? null, { cwd: "C:\\repo" });
    expect(out).toContain('data-path="C:\\repo\\a.ts" data-type="file" data-line="12"');
    expect(out).toContain('<span class="path-chip-base">a.ts</span><span class="path-chip-loc">:12</span>');
    expect(out).toContain('<span class="path-chip-dir">src\\</span><span class="path-chip-base">b.ts</span>');
    expect(withPathChips(markdownToHtml("`C:\\gone.ts`"), (p) => files[p] ?? null, { cwd: "C:\\repo" }))
      .toContain('<code class="path-missing" title="Not found">C:\\gone.ts</code>');
  });
});
