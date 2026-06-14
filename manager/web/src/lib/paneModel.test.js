import { describe, it, expect } from "vitest";
import {
  clampCount, resizePanes, focusAfterResize,
  removePane, focusAfterRemove, pruneDeadPanes, MAX_PANES,
} from "./paneModel.js";

describe("clampCount", () => {
  it("bounds to [1, MAX_PANES]", () => {
    expect(clampCount(0)).toBe(1);
    expect(clampCount(-3)).toBe(1);
    expect(clampCount(3)).toBe(3);
    expect(clampCount(MAX_PANES + 5)).toBe(MAX_PANES);
  });
  it("defaults non-finite to 1", () => {
    expect(clampCount(NaN)).toBe(1);
    expect(clampCount(undefined)).toBe(1);
  });
});

describe("resizePanes", () => {
  it("grows by appending empty slots", () => {
    expect(resizePanes(["a"], 3)).toEqual(["a", null, null]);
  });
  it("shrinks by dropping the tail", () => {
    expect(resizePanes(["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });
  it("returns the same reference when length is unchanged", () => {
    const a = ["a", "b"];
    expect(resizePanes(a, 2)).toBe(a);
  });
  it("clamps the target count", () => {
    expect(resizePanes(["a"], 99)).toHaveLength(MAX_PANES);
    expect(resizePanes(["a", "b"], 0)).toEqual(["a"]);
  });
});

describe("focusAfterResize", () => {
  it("focuses the first new pane when growing", () => {
    expect(focusAfterResize(0, 1, 2)).toBe(1);
    expect(focusAfterResize(0, 1, 4)).toBe(1);
  });
  it("keeps an in-range focus when shrinking", () => {
    expect(focusAfterResize(0, 3, 2)).toBe(0);
  });
  it("clamps an out-of-range focus when shrinking", () => {
    expect(focusAfterResize(2, 3, 1)).toBe(0);
    expect(focusAfterResize(3, 4, 2)).toBe(1);
  });
});

describe("removePane", () => {
  it("removes the slot at i", () => {
    expect(removePane(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });
  it("never drops below one pane", () => {
    const a = ["a"];
    expect(removePane(a, 0)).toBe(a);
  });
});

describe("focusAfterRemove", () => {
  it("shifts down when a pane before the focus is removed", () => {
    expect(focusAfterRemove(2, 0, 2)).toBe(1);
  });
  it("keeps the index when a pane after the focus is removed", () => {
    expect(focusAfterRemove(0, 2, 2)).toBe(0);
  });
  it("lands on the neighbor when the focused pane is removed", () => {
    expect(focusAfterRemove(2, 2, 2)).toBe(1); // was last → clamps to new last
    expect(focusAfterRemove(1, 1, 2)).toBe(1); // middle → same index, now next agent
  });
});

describe("pruneDeadPanes", () => {
  const alive = (s) => new Set(s);
  it("nulls dead non-focused panes", () => {
    const isAlive = (id) => alive(["a", "c"]).has(id);
    expect(pruneDeadPanes(["a", "b", "c"], 0, isAlive)).toEqual(["a", null, "c"]);
  });
  it("never touches the focused slot", () => {
    const isAlive = () => false;
    expect(pruneDeadPanes(["a", "b"], 1, isAlive)).toEqual([null, "b"]);
  });
  it("leaves empty slots alone and returns same ref when unchanged", () => {
    const a = ["a", null];
    expect(pruneDeadPanes(a, 0, () => true)).toBe(a);
  });
});
