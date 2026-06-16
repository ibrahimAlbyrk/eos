import { describe, it, expect } from "vitest";
import { cmLanguageFor } from "./cmLang.js";

describe("cmLanguageFor", () => {
  it.each(["a.cs", "b.ts", "c.py", "d.go", "e.rb", "f.swift", "g.kt", "h.scss", "Dockerfile", "i.md", "j.yaml", "k.sh"])(
    "resolves a language for %s",
    (name) => {
      expect(cmLanguageFor(`/x/${name}`)).toBeTruthy();
    },
  );

  it("returns null for unknown extensions and no path", () => {
    expect(cmLanguageFor("/x/file.xyz")).toBeNull();
    expect(cmLanguageFor(null)).toBeNull();
    expect(cmLanguageFor("/x/Makefile")).toBeNull();
  });
});
