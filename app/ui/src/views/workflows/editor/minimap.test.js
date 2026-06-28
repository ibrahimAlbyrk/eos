import { describe, it, expect } from "vitest";
import { minimapProjection, unionRect } from "./minimap.js";

describe("minimap — unionRect", () => {
  it("returns the other rect when one is null", () => {
    const r = { x: 1, y: 2, w: 3, h: 4 };
    expect(unionRect(null, r)).toBe(r);
    expect(unionRect(r, null)).toBe(r);
    expect(unionRect(null, null)).toBe(null);
  });

  it("covers both rects", () => {
    expect(unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 5, w: 10, h: 30 }))
      .toEqual({ x: 0, y: 0, w: 30, h: 35 });
  });
});

describe("minimap — minimapProjection", () => {
  const size = { width: 180, height: 120 };

  it("maps the content center to the panel center (aspect-preserving, centered)", () => {
    const bounds = { x: 0, y: 0, w: 200, h: 100 };
    const proj = minimapProjection(bounds, size, 6);
    const center = proj.toMini({ x: 100, y: 50 });
    expect(center.x).toBeCloseTo(size.width / 2, 9);
    expect(center.y).toBeCloseTo(size.height / 2, 9);
  });

  it("toMini / fromMini round-trip", () => {
    const proj = minimapProjection({ x: -40, y: 120, w: 600, h: 300 }, size, 6);
    for (const p of [{ x: -40, y: 120 }, { x: 200, y: 250 }, { x: 560, y: 420 }]) {
      const back = proj.fromMini(proj.toMini(p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it("uses one aspect-preserving scale = min(innerW/w, innerH/h)", () => {
    // 600x100 content into a 180x120 panel (pad 6 → inner 168x108): width-limited.
    const proj = minimapProjection({ x: 0, y: 0, w: 600, h: 100 }, size, 6);
    expect(proj.scale).toBeCloseTo(168 / 600, 9);
  });

  it("degrades to a unit box for empty/zero bounds (no divide-by-zero)", () => {
    const proj = minimapProjection({ x: 0, y: 0, w: 0, h: 0 }, size, 6);
    expect(Number.isFinite(proj.scale)).toBe(true);
    expect(Number.isFinite(proj.toMini({ x: 0, y: 0 }).x)).toBe(true);
  });
});
