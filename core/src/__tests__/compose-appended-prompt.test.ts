import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeAppendedPrompt, composeMemorySection } from "../services/compose-appended-prompt.ts";
import type { MemorySnapshot, MemoryDoc } from "../ports/MemoryProvider.ts";

const doc = (over: Partial<MemoryDoc>): MemoryDoc => ({
  sourceId: "claude", sourceLabel: "CLAUDE.md", nativeFor: [],
  path: "/x/CLAUDE.md", level: "project", content: "x", ...over,
});
const snap = (...docs: MemoryDoc[]): MemorySnapshot => ({ docs });

describe("composeAppendedPrompt — fold memory into the DPI append", () => {
  it("returns the DPI text VERBATIM when there is no memory", () => {
    assert.equal(composeAppendedPrompt("EOS PROTOCOL", null), "EOS PROTOCOL");
    assert.equal(composeAppendedPrompt(null, null), null);
    assert.equal(composeAppendedPrompt("EOS PROTOCOL", snap()), "EOS PROTOCOL");
    assert.equal(composeAppendedPrompt(null, snap()), null);
  });

  it("groups docs under their source label, DPI role first", () => {
    const out = composeAppendedPrompt("EOS PROTOCOL", snap(
      doc({ level: "user", path: "/home/.claude/CLAUDE.md", content: "be concise" }),
      doc({ path: "/repo/CLAUDE.md", content: "use tabs" }),
    ));
    assert.equal(
      out,
      "EOS PROTOCOL\n\n# Project & user instructions\n\n## CLAUDE.md\n\n" +
        "### /home/.claude/CLAUDE.md\n\nbe concise\n\n### /repo/CLAUDE.md\n\nuse tabs",
    );
  });

  it("emits one section per source, in doc order", () => {
    const out = composeMemorySection(snap(
      doc({ sourceId: "claude", sourceLabel: "CLAUDE.md", path: "/repo/CLAUDE.md", content: "C" }),
      doc({ sourceId: "agents", sourceLabel: "AGENTS.md", path: "/repo/AGENTS.md", content: "A" }),
    ));
    assert.equal(out, "# Project & user instructions\n\n## CLAUDE.md\n\n### /repo/CLAUDE.md\n\nC\n\n## AGENTS.md\n\n### /repo/AGENTS.md\n\nA");
  });

  it("drops whitespace-only docs (no empty sections)", () => {
    assert.equal(composeMemorySection(snap(doc({ content: "   " }))), "");
    assert.equal(composeAppendedPrompt("DPI", snap(doc({ content: "  \n" }))), "DPI");
  });
});
