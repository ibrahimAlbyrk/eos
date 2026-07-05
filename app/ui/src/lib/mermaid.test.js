import { describe, it, expect } from "vitest";
import { sanitizeMermaidSource } from "./mermaid.js";

// Pure string transform — no DOM, no mermaid — so jsdom's disagreements with
// real WebKit/Chromium are irrelevant here. Real-browser proof that the
// normalized output actually parses/renders lives in the manual Chrome harness.
describe("sanitizeMermaidSource", () => {
  it("encodes a bare ; in a sequence message body", () => {
    const src = "sequenceDiagram\n  A->>B: do it ; then snap";
    expect(sanitizeMermaidSource(src)).toBe(
      "sequenceDiagram\n  A->>B: do it #59; then snap",
    );
  });

  it("encodes a bare ; in a note body", () => {
    const src = "sequenceDiagram\n  Note over A: first ; second";
    expect(sanitizeMermaidSource(src)).toBe(
      "sequenceDiagram\n  Note over A: first #59; second",
    );
  });

  it("handles every sequence arrow variant", () => {
    const src =
      "sequenceDiagram\n" +
      "  A-->>B: a;b\n" +
      "  A-xB: c;d\n" +
      "  A--)B: e;f\n" +
      "  A->>+B: g;h";
    expect(sanitizeMermaidSource(src)).toBe(
      "sequenceDiagram\n" +
        "  A-->>B: a#59;b\n" +
        "  A-xB: c#59;d\n" +
        "  A--)B: e#59;f\n" +
        "  A->>+B: g#59;h",
    );
  });

  it("leaves flowchart terminator ; untouched", () => {
    const src = "graph TD; A-->B; B-->C;";
    expect(sanitizeMermaidSource(src)).toBe(src);
  });

  it("is a byte-identical no-op when there are no semicolons", () => {
    const src = "sequenceDiagram\n  A->>B: hello\n  Note over B: world";
    expect(sanitizeMermaidSource(src)).toBe(src);
  });

  it("does not double-encode an existing entity", () => {
    const src = "sequenceDiagram\n  A->>B: keep &amp; and #59; but fix ;";
    expect(sanitizeMermaidSource(src)).toBe(
      "sequenceDiagram\n  A->>B: keep &amp; and #59; but fix #59;",
    );
  });

  it("only touches text after the ':' on a message line", () => {
    // ';' before the ':' is structurally impossible in a valid actor id, but
    // confirm the prefix (actors/arrow) is never rewritten.
    const src = "sequenceDiagram\n  A->>B: x; y; z";
    expect(sanitizeMermaidSource(src)).toBe(
      "sequenceDiagram\n  A->>B: x#59; y#59; z",
    );
  });

  it("ignores ; outside sequence diagrams entirely (flowchart node label)", () => {
    const src = 'flowchart TD\n  A["a; b"] --> B';
    expect(sanitizeMermaidSource(src)).toBe(src);
  });
});
