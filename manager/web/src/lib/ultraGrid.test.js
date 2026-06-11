import { describe, it, expect } from "vitest";
import { hash, noise2, cellColor } from "./ultraGrid.js";

describe("ultraGrid", () => {
  it("hash is deterministic and in [0,1)", () => {
    expect(hash(4, 2)).toBe(hash(4, 2));
    for (let i = 0; i < 30; i++) {
      const v = hash(i * 1.3, i % 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("noise2 is deterministic and bounded by its corner hashes", () => {
    expect(noise2(1.4, 7.2)).toBe(noise2(1.4, 7.2));
    for (let x = 0; x < 6; x += 0.37) {
      for (let y = 0; y < 3; y += 0.51) {
        const v = noise2(x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("cellColor renders hsl and brightens with intensity", () => {
    const dim = cellColor(0, 0.5);
    const bright = cellColor(1, 0.5);
    expect(dim).toMatch(/^hsl\([\d.]+,[\d.]+%,[\d.]+%\)$/);
    const lit = (s) => parseFloat(s.match(/,([\d.]+)%\)$/)[1]);
    expect(lit(bright)).toBeGreaterThan(lit(dim));
  });
});
