import { describe, it, expect } from "vitest";
import { fractionOf, nearestIndex, isUltracode } from "./effortScale.js";

describe("effortScale", () => {
  it("maps indices to even fractions", () => {
    expect(fractionOf(0, 6)).toBe(0);
    expect(fractionOf(5, 6)).toBe(1);
    expect(fractionOf(2, 5)).toBe(0.5);
    expect(fractionOf(0, 1)).toBe(0);
  });

  it("snaps a fraction to the nearest stop", () => {
    expect(nearestIndex(0, 6)).toBe(0);
    expect(nearestIndex(1, 6)).toBe(5);
    expect(nearestIndex(0.49, 2)).toBe(0);
    expect(nearestIndex(0.51, 2)).toBe(1);
    expect(nearestIndex(0.3, 6)).toBe(2);
  });

  it("clamps out-of-range fractions", () => {
    expect(nearestIndex(-0.4, 6)).toBe(0);
    expect(nearestIndex(1.7, 6)).toBe(5);
  });

  it("degenerates safely with a single stop", () => {
    expect(nearestIndex(0.8, 1)).toBe(0);
    expect(nearestIndex(0.8, 0)).toBe(0);
  });

  it("identifies ultracode", () => {
    expect(isUltracode("ultracode")).toBe(true);
    expect(isUltracode("xhigh")).toBe(false);
  });
});
