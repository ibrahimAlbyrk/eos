import { describe, it, expect } from "vitest";
import { GAIN_MAX, regularGlass } from "./liquidGlass.js";

const at = (data, w, x, y) => {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};

describe("regularGlass", () => {
  const g = regularGlass(400, 120, 1, 26);
  const { width: W, height: H } = g;
  const offset = (map, x, y) => at(map, W, x, y).slice(0, 2).map((c) => (c / 255 - 0.5) * g.scale);
  const [red, green, blue] = g.disp;

  it("sizes the maps in device px", () => {
    const g2 = regularGlass(400, 120, 2, 26);
    expect([g2.width, g2.height]).toEqual([800, 240]);
    expect(g2.shadow.width).toBe(800 + 80);
  });

  it("samples inward at the rim, as the reference's convex bevel does", () => {
    expect(offset(green, 3, H / 2)[0]).toBeGreaterThan(20);
    expect(offset(green, W - 4, H / 2)[0]).toBeLessThan(-20);
    expect(offset(green, W / 2, 3)[1]).toBeGreaterThan(20);
    expect(offset(green, W / 2, H - 4)[1]).toBeLessThan(-20);
  });

  it("only pulls gently toward the centre past the bevel", () => {
    const [x, y] = offset(green, W / 2, H / 2);
    expect(Math.abs(x)).toBeLessThan(1);
    expect(Math.abs(y)).toBeLessThan(1);
  });

  it("splits red outward and blue inward along the normal", () => {
    const [r] = offset(red, 10, H / 2), [gx] = offset(green, 10, H / 2), [b] = offset(blue, 10, H / 2);
    expect(r).toBeLessThan(gx);
    expect(b).toBeGreaterThan(gx);
  });

  it("lifts the flat middle by the full gain with no added light", () => {
    const [grey, , , alpha] = at(g.shade, W, W / 2, H / 2);
    expect(grey / 255 * GAIN_MAX).toBeCloseTo(1.06, 2);
    expect(alpha).toBe(255);
  });

  it("lights the rim (fresnel) and dims what is behind it", () => {
    const [grey, , , alpha] = at(g.shade, W, 1, H / 2);
    expect(alpha).toBeLessThan(250);
    expect(grey / 255 * GAIN_MAX).toBeLessThan(1);
  });

  it("casts a shadow only outside the panel, heavier just below it", () => {
    const { width: SW, data } = g.shadow;
    const a = (x, y) => at(data, SW, x, y)[3];
    const pad = 20;
    expect(a(pad + W / 2, pad + H / 2)).toBe(0);
    expect(a(pad + W / 2, pad + H + 1)).toBeGreaterThan(a(pad + W / 2, pad + H + 12));
    expect(a(pad + W / 2, pad + H + 1)).toBeGreaterThan(a(pad + W / 2, pad - 2));
  });
});
