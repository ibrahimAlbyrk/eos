import { describe, it, expect } from "vitest";
import { gridOpacity, gridGap, FADE_HIDE, FADE_FULL } from "./gridFade.js";

describe("gridOpacity — zoom→fade", () => {
  it("is fully hidden at/below FADE_HIDE (zoomed out)", () => {
    expect(gridOpacity(FADE_HIDE)).toBe(0);
    expect(gridOpacity(0.2)).toBe(0);
    expect(gridOpacity(0.1)).toBe(0);
  });

  it("is fully shown at/above FADE_FULL (default zoom and in)", () => {
    expect(gridOpacity(FADE_FULL)).toBe(1);
    expect(gridOpacity(1)).toBe(1);
    expect(gridOpacity(2.5)).toBe(1);
  });

  it("eases smoothly between the thresholds (no hard cut)", () => {
    const mid = gridOpacity((FADE_HIDE + FADE_FULL) / 2);
    expect(mid).toBeCloseTo(0.5, 5);
    const lo = gridOpacity(0.45);
    const hi = gridOpacity(0.7);
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeLessThan(hi);
    expect(hi).toBeLessThan(1);
  });

  it("is monotonically non-decreasing across the zoom range", () => {
    let prev = -1;
    for (let z = 0.2; z <= 2.5; z += 0.05) {
      const o = gridOpacity(z);
      expect(o).toBeGreaterThanOrEqual(prev);
      prev = o;
    }
  });
});

describe("gridGap — level-of-detail spacing", () => {
  it("is the base gap at default zoom and finer (never below base)", () => {
    expect(gridGap(1, 22)).toBe(22);
    expect(gridGap(2.5, 22)).toBe(22);
  });

  it("doubles each time zoom halves below 1", () => {
    expect(gridGap(0.5, 22)).toBe(44);
    expect(gridGap(0.25, 22)).toBe(88);
  });

  it("keeps screen spacing (gap*zoom) roughly stable across zoom-out", () => {
    for (let z = 0.2; z <= 1; z += 0.05) {
      const screen = gridGap(z, 22) * z;
      expect(screen).toBeGreaterThan(13);
      expect(screen).toBeLessThan(33);
    }
  });

  it("falls back to base for non-positive/invalid zoom", () => {
    expect(gridGap(0, 22)).toBe(22);
    expect(gridGap(-1, 22)).toBe(22);
    expect(gridGap(NaN, 22)).toBe(22);
  });
});
