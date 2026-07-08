import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { codeLensLabel, buildCodeLensDeco } from "./cmCodeLens.js";

describe("codeLensLabel", () => {
  it("shows a placeholder while the count is unresolved", () => {
    expect(codeLensLabel(null)).toBe("…");
    expect(codeLensLabel(undefined)).toBe("…");
  });
  it("pluralizes honestly", () => {
    expect(codeLensLabel(0)).toBe("0 references");
    expect(codeLensLabel(1)).toBe("1 reference");
    expect(codeLensLabel(3)).toBe("3 references");
  });
});

describe("buildCodeLensDeco", () => {
  const state = EditorState.create({ doc: "a\nb\nc\nd\ne" }); // 5 lines

  it("anchors one widget per in-range def at the line start", () => {
    const deco = buildCodeLensDeco(state, [
      { line: 2, name: "b", count: 1 },
      { line: 4, name: "d", count: 0 },
    ], () => {});
    const froms = [];
    deco.between(0, state.doc.length, (from) => { froms.push(from); });
    expect(froms).toEqual([state.doc.line(2).from, state.doc.line(4).from]);
  });

  it("skips defs whose line falls outside the live doc", () => {
    const deco = buildCodeLensDeco(state, [
      { line: 0, name: "zero" },
      { line: 99, name: "past-end" },
      { line: 3, name: "ok" },
    ], () => {});
    let n = 0;
    deco.between(0, state.doc.length, () => { n++; });
    expect(n).toBe(1);
  });
});
