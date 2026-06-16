import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { cmLanguageFor } from "./cmLang.js";

function pressEnter(doc, pos, filePath, unit) {
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [indentUnit.of(unit), cmLanguageFor(filePath)],
  });
  let next = null;
  insertNewlineAndIndent({ state, dispatch: (tr) => { next = tr.state; } });
  return next.doc.toString();
}

describe("Enter auto-indent", () => {
  it("indents after { in C#", () => {
    expect(pressEnter("class A {", 9, "/x/A.cs", "    ")).toBe("class A {\n    ");
  });

  it("opens a block between braces in C#", () => {
    expect(pressEnter("class A {}", 9, "/x/A.cs", "    ")).toBe("class A {\n    \n}");
  });

  it("keeps indentation of plain statements in C#", () => {
    const doc = "class A {\n    int x = 1;";
    expect(pressEnter(doc, doc.length, "/x/A.cs", "    ")).toBe("class A {\n    int x = 1;\n    ");
  });

  it("indents after : in Python", () => {
    expect(pressEnter("def f():", 8, "/x/f.py", "    ")).toBe("def f():\n    ");
  });

  it("indents after { in JS with 2-space unit", () => {
    expect(pressEnter("if (x) {", 8, "/x/f.js", "  ")).toBe("if (x) {\n  ");
  });
});
