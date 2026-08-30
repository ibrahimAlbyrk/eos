import { describe, it, expect } from "vitest";
import { DEVICE_DIMS, centerDeviceRect } from "./deviceViewport.js";

// The device-centering fix (FIX 3): a device-sized view is centered in the panel
// rect, not anchored top-left. This mirrors ViewManager.viewRectFor in the main
// process — the same dims + formula, verified here without Electron.

describe("centerDeviceRect", () => {
  it("centers a mobile device inside a larger panel", () => {
    const r = centerDeviceRect("mobile", { x: 0, y: 0, width: 1000, height: 900 });
    expect(r.width).toBe(DEVICE_DIMS.mobile.width); // 375
    expect(r.height).toBe(DEVICE_DIMS.mobile.height); // 812
    expect(r.x).toBe(Math.round((1000 - 375) / 2)); // centered horizontally → 313
    expect(r.y).toBe(Math.round((900 - 812) / 2)); // centered vertically → 44
  });

  it("offsets by the panel origin so the rect stays inside the panel", () => {
    const r = centerDeviceRect("mobile", { x: 100, y: 50, width: 1000, height: 900 });
    expect(r.x).toBe(100 + Math.round((1000 - 375) / 2));
    expect(r.y).toBe(50 + Math.round((900 - 812) / 2));
  });

  it("clamps a device larger than the panel so it never overflows into adjacent UI", () => {
    const r = centerDeviceRect("tablet", { x: 0, y: 0, width: 500, height: 600 });
    expect(r.width).toBe(500); // clamped to panel width (< 768)
    expect(r.height).toBe(600); // clamped to panel height (< 1024)
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });

  it("responsive fills the whole panel (no device box)", () => {
    const r = centerDeviceRect("responsive", { x: 12, y: 8, width: 1000, height: 900 });
    expect(r).toEqual({ x: 12, y: 8, width: 1000, height: 900 });
  });
});
