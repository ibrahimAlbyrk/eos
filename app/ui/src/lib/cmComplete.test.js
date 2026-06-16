import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { cmLanguageFor } from "./cmLang.js";

function completionSources(filePath, doc = "") {
  const state = EditorState.create({ doc, extensions: [cmLanguageFor(filePath)] });
  return state.languageDataAt("autocomplete", 0);
}

describe("autocomplete wiring", () => {
  it.each(["a.cs", "b.swift", "c.rb", "d.sh", "e.kt"])(
    "legacy mode %s falls back to document-word completion",
    (name) => {
      expect(completionSources(`/x/${name}`).length).toBeGreaterThan(0);
    },
  );

  it.each(["a.js", "b.ts", "c.py", "d.html", "e.css", "f.sql"])(
    "first-class %s ships its own completion source",
    (name) => {
      expect(completionSources(`/x/${name}`).length).toBeGreaterThan(0);
    },
  );
});
