import { describe, it, expect } from "vitest";
import { deriveTurns, plainPreview, withOlderTurns } from "./turnIndex.js";

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

describe("withOlderTurns", () => {
  const t = (key, startTs, preview = "") => ({ key, title: key, preview, tools: 0, startTs, endTs: startTs });

  it("prepends only the turns that start before the window's first one", () => {
    const all = [t("a", 1), t("b", 2), t("c", 3), t("d", 4)];
    const win = [t("c", 3, "rich"), t("d", 4, "rich")];
    expect(withOlderTurns(all, win)).toEqual([t("a", 1), t("b", 2), ...win]);
  });

  it("indexes every turn when the window holds no prompt yet", () => {
    const all = [t("a", 1), t("b", 2)];
    expect(withOlderTurns(all, [])).toEqual(all);
  });

  it("returns the window as-is when nothing is older", () => {
    const win = [t("a", 1)];
    expect(withOlderTurns([t("a", 1)], win)).toBe(win);
  });
});
