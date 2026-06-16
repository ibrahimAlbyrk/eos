import { describe, it, expect } from "vitest";
import { detectIndentUnit } from "./indentDetect.js";

describe("detectIndentUnit", () => {
  it("detects 4-space indentation from content", () => {
    const cs = "class Foo\n{\n    void Bar()\n    {\n        DoIt();\n    }\n}\n";
    expect(detectIndentUnit(cs, "/a/Foo.cs")).toBe("    ");
  });

  it("detects 2-space indentation from content", () => {
    const js = "function f() {\n  if (x) {\n    g();\n  }\n}\n";
    expect(detectIndentUnit(js, "/a/f.js")).toBe("  ");
  });

  it("detects tab indentation from content", () => {
    const go = "func main() {\n\tfmt.Println(1)\n\tif x {\n\t\treturn\n\t}\n}\n";
    expect(detectIndentUnit(go, "/a/main.go")).toBe("\t");
  });

  it("content wins over extension default", () => {
    const cs = "class Foo {\n  void Bar() {\n    DoIt();\n  }\n}\n";
    expect(detectIndentUnit(cs, "/a/Foo.cs")).toBe("  ");
  });

  it("falls back to 4 spaces for C#/Python on flat content", () => {
    expect(detectIndentUnit("var x = 1;", "/a/Foo.cs")).toBe("    ");
    expect(detectIndentUnit("", "/a/f.py")).toBe("    ");
  });

  it("falls back to 2 spaces for js/json/unknown", () => {
    expect(detectIndentUnit("const x = 1;", "/a/f.js")).toBe("  ");
    expect(detectIndentUnit("", "/a/f.unknownext")).toBe("  ");
  });

  it("falls back to tab for go and makefile", () => {
    expect(detectIndentUnit("package main", "/a/main.go")).toBe("\t");
    expect(detectIndentUnit("all: build", "/a/Makefile")).toBe("\t");
  });

  it("ignores blank lines between indented lines", () => {
    const text = "a {\n    b;\n\n    c;\n}\n";
    expect(detectIndentUnit(text, "/a/f.js")).toBe("    ");
  });
});
