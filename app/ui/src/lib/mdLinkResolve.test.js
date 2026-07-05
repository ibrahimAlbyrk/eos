import { describe, it, expect } from "vitest";
import { classifyHref, decideLinkAction, resolveRelativePath } from "./mdLinkResolve.js";

describe("classifyHref", () => {
  it("flags in-doc anchors as fragment", () => {
    expect(classifyHref("#physics")).toBe("fragment");
    expect(classifyHref("#")).toBe("fragment");
  });

  it("flags schemed and protocol-relative URLs as external", () => {
    for (const h of ["http://x.com", "https://x.com/a", "mailto:a@b.com", "//cdn.example.com/x"]) {
      expect(classifyHref(h)).toBe("external");
    }
  });

  it("flags bare/relative/absolute filesystem paths as relative", () => {
    for (const h of ["S2.md", "./S2.md", "../gdd/S3.md", "sub/dir/x.md", "/abs/y.md"]) {
      expect(classifyHref(h)).toBe("relative");
    }
  });

  it("treats empty/nullish as external (inert — lets the click bubble)", () => {
    expect(classifyHref("")).toBe("external");
    expect(classifyHref(null)).toBe("external");
  });
});

describe("resolveRelativePath", () => {
  const FROM = "/Users/me/docs/tdd/S1-overview.md";

  it("resolves a bare sibling against the file's directory", () => {
    expect(resolveRelativePath(FROM, "S2-physics.md")).toBe("/Users/me/docs/tdd/S2-physics.md");
  });

  it("resolves an explicit ./ prefix", () => {
    expect(resolveRelativePath(FROM, "./S2-physics.md")).toBe("/Users/me/docs/tdd/S2-physics.md");
  });

  it("resolves ../ up a directory", () => {
    expect(resolveRelativePath(FROM, "../gdd/S3.md")).toBe("/Users/me/docs/gdd/S3.md");
  });

  it("resolves nested ./sub/ paths", () => {
    expect(resolveRelativePath(FROM, "./sub/deep/S4.md")).toBe("/Users/me/docs/tdd/sub/deep/S4.md");
  });

  it("clamps .. at the filesystem root", () => {
    expect(resolveRelativePath("/a/b.md", "../../../../x.md")).toBe("/x.md");
  });

  it("strips a #fragment before resolving", () => {
    expect(resolveRelativePath(FROM, "./S2.md#physics-model")).toBe("/Users/me/docs/tdd/S2.md");
  });

  it("strips a ?query before resolving", () => {
    expect(resolveRelativePath(FROM, "./S2.md?v=2")).toBe("/Users/me/docs/tdd/S2.md");
  });

  it("percent-decodes escaped path segments", () => {
    expect(resolveRelativePath(FROM, "./My%20Notes.md")).toBe("/Users/me/docs/tdd/My Notes.md");
  });

  it("keeps an already-absolute href absolute (ignores the from-file dir)", () => {
    expect(resolveRelativePath(FROM, "/etc/other.md")).toBe("/etc/other.md");
  });

  it("resolves a sibling of a top-level file", () => {
    expect(resolveRelativePath("/S1.md", "S2.md")).toBe("/S2.md");
  });
});

describe("decideLinkAction", () => {
  const FROM = "/Users/me/docs/tdd/S1-overview.md";

  it("opens a bare sibling .md in-preview (the regression case)", () => {
    expect(decideLinkAction(FROM, "S2-physics.md")).toEqual({
      action: "open-md",
      path: "/Users/me/docs/tdd/S2-physics.md",
    });
  });

  it("opens ./ and ../ relative .md links in-preview", () => {
    expect(decideLinkAction(FROM, "./S2.md")).toEqual({ action: "open-md", path: "/Users/me/docs/tdd/S2.md" });
    expect(decideLinkAction(FROM, "../gdd/S3.md")).toEqual({ action: "open-md", path: "/Users/me/docs/gdd/S3.md" });
  });

  it("opens a .md link even with a trailing #fragment or ?query", () => {
    expect(decideLinkAction(FROM, "S2.md#physics")).toEqual({ action: "open-md", path: "/Users/me/docs/tdd/S2.md" });
  });

  it("treats an in-doc #anchor as a fragment scroll", () => {
    expect(decideLinkAction(FROM, "#physics-model")).toEqual({ action: "fragment" });
  });

  it("ignores external links (they bubble to the OS browser)", () => {
    for (const h of ["https://example.com", "http://x.io/a", "mailto:a@b.com"]) {
      expect(decideLinkAction(FROM, h)).toEqual({ action: "ignore" });
    }
  });

  it("ignores non-.md relative links (out of scope — left to bubble)", () => {
    expect(decideLinkAction(FROM, "./diagram.png")).toEqual({ action: "ignore" });
    expect(decideLinkAction(FROM, "../src/main.ts")).toEqual({ action: "ignore" });
  });
});
