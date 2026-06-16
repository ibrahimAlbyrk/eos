import { describe, it, expect } from "vitest";
import { escChord, ESC_CHORD_WINDOW_MS } from "./escapeChord.js";

describe("escChord", () => {
  it("first press arms but is not a double", () => {
    expect(escChord(0, 10_000)).toEqual({ isDouble: false, ts: 10_000 });
  });

  it("second press within the window is a double", () => {
    expect(escChord(10_000, 10_000 + ESC_CHORD_WINDOW_MS).isDouble).toBe(true);
  });

  it("second press outside the window is not a double", () => {
    expect(escChord(10_000, 10_000 + ESC_CHORD_WINDOW_MS + 1).isDouble).toBe(false);
  });

  it("detects pairwise: three fast presses yield two doubles", () => {
    const a = escChord(0, 10_000);
    const b = escChord(a.ts, 10_200);
    const c = escChord(b.ts, 10_400);
    expect(a.isDouble).toBe(false);
    expect(b.isDouble).toBe(true);
    expect(c.isDouble).toBe(true);
  });

  it("respects a custom window", () => {
    expect(escChord(10_000, 10_300, 200).isDouble).toBe(false);
    expect(escChord(10_000, 10_150, 200).isDouble).toBe(true);
  });
});
