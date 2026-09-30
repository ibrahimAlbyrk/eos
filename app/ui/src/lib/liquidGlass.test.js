import { describe, it, expect } from "vitest";
import { DARK_GLASS, GAIN_MAX, SHADOW_PAD, glassMaps } from "./liquidGlass.js";

const PAD = SHADOW_PAD;

// maps for a panel at dpr 1, read at panel coordinates (the maps carry the pad)
function panel(w, h, radius) {
  const g = glassMaps(w, h, 1, radius);
  const at = (data, x, y) => {
    const i = ((y + PAD) * g.width + x + PAD) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  const offset = (c, x, y) => at(g.disp[c], x, y).slice(0, 2).map((v) => (v / 255 - 0.5) * g.scale);
  return { g, at, offset };
}

describe("glassMaps", () => {
  const W = 400, H = 120;
  const { g, at, offset } = panel(W, H, 26);
  const [RED, GREEN, BLUE] = [0, 1, 2];

  it("sizes every map to the panel plus the shadow pad, in device px", () => {
    const g2 = glassMaps(W, H, 2, 26);
    expect([g2.width, g2.height]).toEqual([(W + PAD * 2) * 2, (H + PAD * 2) * 2]);
    expect(g2.shadow.length).toBe(g2.width * g2.height * 4);
  });

  it("samples inward at the rim, as the reference's convex bevel does", () => {
    expect(offset(GREEN, 3, H / 2)[0]).toBeGreaterThan(20);
    expect(offset(GREEN, W - 4, H / 2)[0]).toBeLessThan(-20);
    expect(offset(GREEN, W / 2, 3)[1]).toBeGreaterThan(20);
    expect(offset(GREEN, W / 2, H - 4)[1]).toBeLessThan(-20);
  });

  it("only pulls gently toward the centre past the bevel", () => {
    const [x, y] = offset(GREEN, W / 2, H / 2);
    expect(Math.abs(x)).toBeLessThan(1);
    expect(Math.abs(y)).toBeLessThan(1);
  });

  it("splits red outward and blue inward along the normal", () => {
    const [r] = offset(RED, 10, H / 2), [gx] = offset(GREEN, 10, H / 2), [b] = offset(BLUE, 10, H / 2);
    expect(r).toBeLessThan(gx);
    expect(b).toBeGreaterThan(gx);
  });

  it("never samples past the padded crop (the reference clamps at its edge)", () => {
    const pill = panel(200, 48, 24);
    const [, dy] = pill.offset(GREEN, 100, 1);
    expect(1.5 + dy).toBeLessThanOrEqual(48 + PAD);
  });

  it("blurs like the reference's six 9-tap rounds (σ in CSS px)", () => {
    expect(g.blur).toBeCloseTo(5.17, 2);
    expect(glassMaps(W, H, 2, 26).blur).toBeCloseTo(5.17 / 2, 2);
    expect(glassMaps(W, H, 1, 26, DARK_GLASS).blur).toBeCloseTo(4.14, 2);
  });

  it("shows only the blurred backdrop in the middle, 15% sharp at the rim", () => {
    expect(at(g.disp[RED], W / 2, H / 2)[3]).toBe(255);
    expect(at(g.disp[RED], W / 2, 1)[3]).toBe(Math.round(255 * 0.85));
  });

  it("lifts the flat middle by the full gain with no added light", () => {
    const [grey, , , alpha] = at(g.shade, W / 2, H / 2);
    expect(grey / 255 * GAIN_MAX).toBeCloseTo(1.06, 2);
    expect(alpha).toBe(255);
  });

  it("darkens the flat middle by Dark Glass's brightness", () => {
    const dark = glassMaps(W, H, 1, 26, DARK_GLASS);
    const i = ((H / 2 + PAD) * dark.width + W / 2 + PAD) * 4;
    expect(dark.shade[i] / 255 * GAIN_MAX).toBeCloseTo(0.7 * 1.06, 2);
  });

  it("lights the rim (fresnel) and dims what is behind it", () => {
    const [grey, , , alpha] = at(g.shade, 1, H / 2);
    expect(alpha).toBeLessThan(250);
    expect(grey / 255 * GAIN_MAX).toBeLessThan(1);
  });

  it("fades the glass out over the outermost pixel via the green map's alpha", () => {
    expect(at(g.disp[GREEN], W / 2, H / 2)[3]).toBe(255);
    expect(at(g.disp[GREEN], W / 2, 0)[3]).toBeLessThan(255);
    expect(at(g.disp[GREEN], W / 2, -2)[3]).toBe(0);
  });

  it("casts a shadow only outside the panel, heavier just below it", () => {
    const a = (x, y) => at(g.shadow, x, y)[3];
    expect(a(W / 2, H / 2)).toBe(0);
    expect(a(W / 2, H + 1)).toBeGreaterThan(a(W / 2, H + 12));
    expect(a(W / 2, H + 1)).toBeGreaterThan(a(W / 2, -2));
  });
});
