import { describe, it, expect } from "vitest";
import { tokenRegions, tokenAt, atomicCaretTarget } from "./composerTokens.js";

const slashNames = new Set(["clear", "commit"]);

describe("tokenRegions", () => {
  it("finds a /slash command token as atomic with correct boundaries", () => {
    expect(tokenRegions("/clear", { slashNames })).toEqual([
      { start: 0, end: 6, kind: "cmd", key: "clear", atomic: true },
    ]);
  });

  it("finds an @path token, adding the @ prefix to the display key", () => {
    expect(tokenRegions("see @src/a.ts here", { paths: ["src/a.ts"] })).toEqual([
      { start: 4, end: 13, kind: "path", key: "src/a.ts", atomic: true },
    ]);
  });

  it("finds [paste] and [attachment] label tokens", () => {
    const r = tokenRegions("a [Pasted text #1] b [report.txt]", {
      pasteKeys: ["[Pasted text #1]"],
      attachmentLabels: ["[report.txt]"],
    });
    expect(r).toEqual([
      { start: 2, end: 18, kind: "paste", key: "[Pasted text #1]", atomic: true },
      { start: 21, end: 33, kind: "attachment", key: "[report.txt]", atomic: true },
    ]);
  });

  it("marks {{placeholder}} regions atomic:false (typed-over, not atomic)", () => {
    expect(tokenRegions("hi {{name}}", {})).toEqual([
      { start: 3, end: 11, kind: "placeholder", key: "name", atomic: false },
    ]);
  });

  it("excludes unknown slash names", () => {
    expect(tokenRegions("/unknown stuff", { slashNames })).toEqual([]);
  });

  it("returns multiple mixed tokens sorted by start", () => {
    const r = tokenRegions("/clear then @a.ts and {{x}}", {
      slashNames,
      paths: ["a.ts"],
    });
    expect(r.map((t) => [t.start, t.kind])).toEqual([
      [0, "cmd"],
      [12, "path"],
      [22, "placeholder"],
    ]);
  });

  it("finds repeated same-kind tokens", () => {
    const r = tokenRegions("@a.ts and @a.ts", { paths: ["a.ts"] });
    expect(r.map((t) => t.start)).toEqual([0, 10]);
  });

  it("drops a region overlapping one already kept (non-overlapping invariant)", () => {
    // Two scanners yield the same [0,3] region; dedup keeps exactly one.
    const r = tokenRegions("[a]", { pasteKeys: ["[a]"], attachmentLabels: ["[a]"] });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ start: 0, end: 3 });
  });
});

describe("atomicCaretTarget", () => {
  // "/clear" occupies [0,6); a space at 6; "x" at 7.
  const regions = tokenRegions("/clear x", { slashNames });

  it("ArrowRight from the token start jumps to the token end", () => {
    expect(atomicCaretTarget(regions, 0, "right")).toBe(6);
  });

  it("ArrowRight from inside the token jumps to the token end", () => {
    expect(atomicCaretTarget(regions, 3, "right")).toBe(6);
  });

  it("ArrowLeft from the token end jumps to the token start", () => {
    expect(atomicCaretTarget(regions, 6, "left")).toBe(0);
  });

  it("ArrowLeft from inside the token jumps to the token start", () => {
    expect(atomicCaretTarget(regions, 3, "left")).toBe(0);
  });

  it("returns null when no token straddles the step (native char move)", () => {
    expect(atomicCaretTarget(regions, 7, "right")).toBeNull();
    expect(atomicCaretTarget(regions, 6, "right")).toBeNull(); // caret just after token, moving away
    expect(atomicCaretTarget(regions, 0, "left")).toBeNull();
  });

  it("ignores non-atomic placeholder regions", () => {
    const ph = tokenRegions("{{name}}", {});
    expect(atomicCaretTarget(ph, 3, "right")).toBeNull();
    expect(atomicCaretTarget(ph, 3, "left")).toBeNull();
  });
});

describe("tokenAt", () => {
  const regions = tokenRegions("/clear x", { slashNames }); // token [0,6)

  it("interiorOnly matches strictly inside, not on boundaries", () => {
    expect(tokenAt(regions, 3, { interiorOnly: true })?.kind).toBe("cmd");
    expect(tokenAt(regions, 0, { interiorOnly: true })).toBeNull();
    expect(tokenAt(regions, 6, { interiorOnly: true })).toBeNull();
  });

  it("default (half-open) matches the end boundary like Backspace delete", () => {
    expect(tokenAt(regions, 6)?.kind).toBe("cmd");
    expect(tokenAt(regions, 0)).toBeNull();
  });

  it("skips non-atomic placeholders by default", () => {
    const ph = tokenRegions("{{name}}", {});
    expect(tokenAt(ph, 3, { interiorOnly: true })).toBeNull();
  });
});
