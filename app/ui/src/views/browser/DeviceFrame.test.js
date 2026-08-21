import { describe, it, expect } from "vitest";
import { letterboxSize, DEVICE_DIMS } from "./DeviceFrame.jsx";
import { canvasToPage } from "./paintFrame.js";

describe("letterboxSize", () => {
  it("fits by height in a wide panel and preserves the device aspect ratio", () => {
    const box = letterboxSize({ width: 1000, height: 600 }, DEVICE_DIMS.mobile);
    expect(box.height).toBeCloseTo(600, 5); // height-limited: 600/812 < 1000/375
    expect(box.width).toBeLessThan(1000); // narrower than the panel → grey gutters
    expect(box.width / box.height).toBeCloseTo(375 / 812, 5);
  });

  it("fits by width in a narrow panel and still preserves the aspect ratio", () => {
    const box = letterboxSize({ width: 200, height: 2000 }, DEVICE_DIMS.mobile);
    expect(box.width).toBeCloseTo(200, 5); // width-limited now
    expect(box.height).toBeLessThan(2000);
    expect(box.width / box.height).toBeCloseTo(375 / 812, 5);
  });

  it("is null until the container is measured", () => {
    expect(letterboxSize({ width: 0, height: 0 }, DEVICE_DIMS.mobile)).toBeNull();
    expect(letterboxSize(null, DEVICE_DIMS.tablet)).toBeNull();
  });
});

// The click-misplacement guard: canvasToPage measures the element's OWN box, so
// as long as the canvas (and the overlays sharing its box) are the letterboxed
// size, a point maps to the emulated viewport — not the wider panel.
describe("coordinate mapping under emulation", () => {
  const panel = { width: 1000, height: 600 };
  const box = letterboxSize(panel, DEVICE_DIMS.mobile); // the letterboxed canvas box

  it("maps the box centre to the emulated viewport centre", () => {
    const p = canvasToPage(box.width / 2, box.height / 2, box.width, box.height, DEVICE_DIMS.mobile);
    expect(p.x).toBe(Math.round(375 / 2)); // 188
    expect(p.y).toBe(Math.round(812 / 2)); // 406
  });

  it("maps the box edges to the emulated viewport bounds", () => {
    expect(canvasToPage(box.width, box.height, box.width, box.height, DEVICE_DIMS.mobile))
      .toEqual({ x: 375, y: 812 });
    expect(canvasToPage(0, 0, box.width, box.height, DEVICE_DIMS.mobile)).toEqual({ x: 0, y: 0 });
  });

  it("would misplace the point if scaled against the panel width instead of the box", () => {
    // Same visual centre click, but wrongly divided by the panel width (the bug
    // this phase guards against): lands far from the emulated viewport centre.
    const wrong = canvasToPage(box.width / 2, box.height / 2, panel.width, box.height, DEVICE_DIMS.mobile);
    expect(wrong.x).not.toBe(Math.round(375 / 2));
    expect(wrong.x).toBeLessThan(100); // nowhere near 188
  });
});
