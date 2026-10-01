import { describe, it, expect } from "vitest";
import { isArtifactUrl, artifactLabel, artifactFromTool, collectArtifacts, artifactChipHtml, withArtifactChips } from "./artifactLink.js";
import { markdownToHtml } from "./markdown.js";

const PAGE = "https://claude.ai/artifact/YBc8tWaK41fiYSKdCZ88EM";
const CODE_PAGE = "https://claude.ai/code/artifact/9e41c7d2-1b3a-4c5d-8e9f-0a1b2c3d4e5f";
const TYPE = "https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd";

describe("isArtifactUrl", () => {
  it("accepts artifact pages on claude.ai / claude.com, incl. preview. and a tail", () => {
    expect(isArtifactUrl(PAGE)).toBe(true);
    expect(isArtifactUrl(CODE_PAGE)).toBe(true);
    expect(isArtifactUrl("https://preview.claude.com/artifact/abc123")).toBe(true);
    expect(isArtifactUrl(PAGE + "?v=2#top")).toBe(true);
  });

  it("rejects galleries, other hosts and lookalikes", () => {
    expect(isArtifactUrl("https://claude.ai/code/artifacts")).toBe(false);
    expect(isArtifactUrl("https://evil.example/artifact/abc")).toBe(false);
    expect(isArtifactUrl("https://claude.ai.evil.example/artifact/abc")).toBe(false);
    expect(isArtifactUrl("http://claude.ai/artifact/abc")).toBe(false);
    expect(isArtifactUrl(undefined)).toBe(false);
  });
});

describe("artifactLabel", () => {
  it("keeps host + path and cuts the id short", () => {
    expect(artifactLabel(PAGE)).toBe("claude.ai/artifact/YBc8tWaK…");
    expect(artifactLabel(CODE_PAGE)).toBe("claude.ai/code/artifact/9e41c7d2…");
    expect(artifactLabel("https://claude.ai/artifact/short")).toBe("claude.ai/artifact/short");
  });
});

describe("artifactFromTool", () => {
  const tool = (input, text, isError = false) => ({ name: "Artifact", input, result: text == null ? null : { text, isError } });

  it("reads a new typed artifact from the create result, not the type link after it", () => {
    const t = tool(
      { action: "publish", type_url: TYPE, title: "Subagent Chips & Panel" },
      `Created a new Artifact at ${PAGE} (version 1-a) from the Artifact type ${TYPE} (release 2-b).`,
    );
    expect(artifactFromTool(t)).toEqual({ url: PAGE, title: "Subagent Chips & Panel", verb: "Published" });
  });

  it("marks an update and leaves a typed artifact's data file out of the title", () => {
    const t = tool(
      { url: PAGE, root: "/tmp/canvas", file_path: "/tmp/canvas/project/Main.dc.html" },
      `Updated the Artifact at ${PAGE} (Version 3, version id 3-c)`,
    );
    expect(artifactFromTool(t)).toEqual({ url: PAGE, title: null, verb: "Updated" });
  });

  it("titles a plain page publish by its basename", () => {
    const t = tool({ file_path: "/x/release-notes.html" }, `Published /x/release-notes.html at ${CODE_PAGE}`);
    expect(artifactFromTool(t)).toEqual({ url: CODE_PAGE, title: "release-notes", verb: "Published" });
  });

  it("chips an open and a running update (url known up front)", () => {
    expect(artifactFromTool(tool({ action: "open", url: PAGE }, "")).verb).toBe("Opened");
    expect(artifactFromTool(tool({ url: PAGE, file_path: "/x/a.html" }, null))?.url).toBe(PAGE);
  });

  it("ignores calls that don't name a page", () => {
    expect(artifactFromTool(tool({ action: "quickstart", intent: "design" }, `type_url: ${TYPE}`))).toBe(null);
    expect(artifactFromTool(tool({ action: "read", url: PAGE }, "<html>"))).toBe(null);
    expect(artifactFromTool(tool({ action: "list" }, `${PAGE} · Title`))).toBe(null);
    expect(artifactFromTool(tool({ url: PAGE, asset: true, file_path: "/x/a.png" }, "uploaded"))).toBe(null);
    expect(artifactFromTool(tool({ title: "x" }, null))).toBe(null);
    expect(artifactFromTool(tool({ url: PAGE }, "refused", true))).toBe(null);
  });
});

describe("collectArtifacts", () => {
  const publish = (input, text, ts) => ({ name: "Artifact", input, result: { text, isError: false }, ts });

  it("lists each page once, newest first, keeping its first title — subagents' too", () => {
    const blocks = [
      { kind: "tool", tool: publish({ type_url: TYPE, title: "Cards" }, `Created a new Artifact at ${PAGE} (v1)`, 1) },
      { kind: "user", text: "hi", ts: 2 },
      { kind: "agentRun", tools: [publish({ file_path: "/x/notes.html" }, `Published /x/notes.html at ${CODE_PAGE}`, 3)] },
      { kind: "tool", tool: publish({ url: PAGE, root: "/r" }, `Updated the Artifact at ${PAGE}`, 4) },
      { kind: "tool", tool: { name: "Read", input: {}, ts: 5 } },
      { kind: "tool", tool: publish({ action: "quickstart" }, `type_url: ${TYPE}`, 6) },
    ];
    expect(collectArtifacts(blocks)).toEqual([
      { url: PAGE, title: "Cards", ts: 4 },
      { url: CODE_PAGE, title: "notes", ts: 3 },
    ]);
  });
});

describe("artifactChipHtml", () => {
  it("escapes the title and url", () => {
    const html = artifactChipHtml({ url: PAGE + '?a="b"&c', title: 'Q&A <b>"x"</b>' });
    expect(html).toContain('href="' + PAGE + '?a=&quot;b&quot;&amp;c"');
    expect(html).toContain('data-title="Q&amp;A &lt;b&gt;&quot;x&quot;&lt;/b&gt;"');
    expect(html).toContain('<span class="art-chip-title">Q&amp;A &lt;b&gt;"x"&lt;/b&gt;</span>');
  });

  it("falls back to the short link when there is no title", () => {
    const html = artifactChipHtml({ url: PAGE, title: null });
    expect(html).not.toContain("data-title");
    expect(html).toContain("claude.ai/artifact/YBc8tWaK…");
  });
});

describe("withArtifactChips", () => {
  it("turns a titled markdown link into a titled chip", () => {
    const out = withArtifactChips(markdownToHtml(`See [Focus & Flow](${PAGE}) here.`));
    expect(out).toContain('class="art-chip"');
    expect(out).toContain('data-title="Focus &amp; Flow"');
    expect(out).toContain("See <a");
  });

  it("gives an autolinked URL the short label, not a title", () => {
    const out = withArtifactChips(markdownToHtml(`Canvas: ${PAGE}`));
    expect(out).toContain('class="art-chip"');
    expect(out).not.toContain("data-title");
  });

  it("leaves other links and code alone", () => {
    const html = markdownToHtml("[docs](https://example.com/artifact/x) and `" + PAGE + "`");
    expect(withArtifactChips(html)).toBe(html);
  });
});
