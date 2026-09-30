import { describe, it, expect } from "vitest";
import { lensDisplacement } from "./lensMap.js";

const px = (data, w, x, y) => {
  const i = (y * w + x) * 4;
  return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
};

describe("lensDisplacement", () => {
  const w = 200, h = 100;
  const data = lensDisplacement(w, h, 26, 34);

  it("leaves the flat middle neutral", () => {
    expect(px(data, w, 100, 50)).toEqual({ r: 128, g: 128, b: 128, a: 255 });
  });

  it("pushes the backdrop outward along the edge normal inside the bevel", () => {
    expect(px(data, w, 2, 50).r).toBeGreaterThan(128 + 100); // left edge → +x
    expect(px(data, w, w - 3, 50).r).toBeLessThan(128 - 100); // right edge → −x
    expect(px(data, w, 100, 2).g).toBeGreaterThan(128 + 100); // top edge → +y
    expect(px(data, w, 100, 50).g).toBe(128);
  });

  it("fades to zero at the inner edge of the bevel", () => {
    expect(Math.abs(px(data, w, 36, 50).r - 128)).toBeLessThanOrEqual(1);
  });

  it("stays neutral outside the rounded corner", () => {
    expect(px(data, w, 0, 0)).toEqual({ r: 128, g: 128, b: 128, a: 255 });
  });
});
