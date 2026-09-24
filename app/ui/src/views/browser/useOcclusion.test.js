import { afterEach, describe, expect, it, vi } from "vitest";
import { isOccluded } from "./useOcclusion.js";

const inside = { id: "placeholder" };
const outside = { id: "layer" };
const el = {
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300 }),
  contains: (node) => node === inside,
};
const hitTest = (fn) => vi.stubGlobal("document", { elementFromPoint: fn });

describe("isOccluded", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is clear when every point hits the body", () => {
    hitTest(() => inside);
    expect(isOccluded(el)).toBe(false);
  });

  it("flags a layer covering part of the body", () => {
    hitTest((x, y) => (x > 300 && y > 200 ? outside : inside));
    expect(isOccluded(el)).toBe(true);
  });

  it("ignores the edge strip where the resize handle sits", () => {
    hitTest((x) => (x < 8 ? outside : inside));
    expect(isOccluded(el)).toBe(false);
  });
});
