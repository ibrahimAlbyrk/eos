import { describe, it, expect } from "vitest";
import { deriveTurns, plainPreview } from "./turnIndex.js";

const keyOf = (b, i) => `${b.kind}-${i}`;

describe("deriveTurns", () => {
  it("opens a turn per prompt and keeps the last assistant text as preview", () => {
    const turns = deriveTurns([
      { kind: "assistant", text: "orphan before any prompt", ts: 1 },
      { kind: "user", text: "fix the bug", ts: 10 },
      { kind: "assistant", text: "Let me look.", ts: 11 },
      { kind: "toolGroup", tools: [{}, {}], ts: 12 },
      { kind: "tool", tool: {}, ts: 13 },
      { kind: "assistant", text: "**Fixed** it.", ts: 20 },
      { kind: "directive", text: "next task", ts: 30 },
    ], keyOf);
    expect(turns).toEqual([
      { key: "user-1", title: "fix the bug", preview: "**Fixed** it.", tools: 3, startTs: 10, endTs: 20 },
      { key: "directive-6", title: "next task", preview: "", tools: 0, startTs: 30, endTs: 30 },
    ]);
  });

  it("collapses whitespace in the title and handles empty prompts", () => {
    const [a, b] = deriveTurns([
      { kind: "user", text: "  line one\n\nline two ", ts: 1 },
      { kind: "user", text: "", ts: 2 },
    ], keyOf);
    expect(a.title).toBe("line one line two");
    expect(b.title).toBe("(empty message)");
  });
});

describe("plainPreview", () => {
  it("flattens markdown but keeps bold markers", () => {
    const md = "# Title\n\n- see [docs](http://x) and `code`\n\n```js\nconst a = 1;\n```\n**done**";
    expect(plainPreview(md)).toBe("Title see docs and code **done**");
  });
});
