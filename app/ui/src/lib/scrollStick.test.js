import { describe, it, expect } from "vitest";
import { shouldStick, nextPinned, followStep } from "./scrollStick.js";

describe("shouldStick", () => {
  it("is true when exactly at bottom (dist 0)", () => {
    expect(shouldStick({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(true);
  });

  it("is true within threshold including a 2px sub-pixel overshoot", () => {
    expect(shouldStick({ scrollHeight: 1002, scrollTop: 800, clientHeight: 200 })).toBe(true);
  });

  it("is true at dist 39 and false at dist 40 (strict < default threshold)", () => {
    expect(shouldStick({ scrollHeight: 1039, scrollTop: 800, clientHeight: 200 })).toBe(true);
    expect(shouldStick({ scrollHeight: 1040, scrollTop: 800, clientHeight: 200 })).toBe(false);
  });

  it("is false at dist 120", () => {
    expect(shouldStick({ scrollHeight: 1120, scrollTop: 800, clientHeight: 200 })).toBe(false);
  });

  it("honors a custom threshold argument", () => {
    expect(shouldStick({ scrollHeight: 1020, scrollTop: 800, clientHeight: 200 }, 10)).toBe(false);
    expect(shouldStick({ scrollHeight: 1005, scrollTop: 800, clientHeight: 200 }, 10)).toBe(true);
  });
});

describe("nextPinned", () => {
  it("self events never change the state", () => {
    expect(nextPinned(true, { distance: 500, deltaTop: -100, isSelf: true })).toBe(true);
    expect(nextPinned(false, { distance: 0, deltaTop: 50, isSelf: true })).toBe(false);
  });

  it("keeps the pin on a clamp after content shrink (scrollTop drops, lands at bottom)", () => {
    expect(nextPinned(true, { distance: 0, deltaTop: -120, isSelf: false })).toBe(true);
  });

  it("unpins on an upward move that ends beyond the threshold (scrollbar drag)", () => {
    expect(nextPinned(true, { distance: 200, deltaTop: -80, isSelf: false })).toBe(false);
  });

  it("stays pinned on a downward user move even while content outruns the viewport", () => {
    expect(nextPinned(true, { distance: 90, deltaTop: 30, isSelf: false })).toBe(true);
  });

  it("re-pins when the user scrolls down into the threshold band", () => {
    expect(nextPinned(false, { distance: 10, deltaTop: 40, isSelf: false })).toBe(true);
  });

  it("does not re-pin on an upward move that lands inside the band (gentle wheel-up)", () => {
    expect(nextPinned(false, { distance: 10, deltaTop: -10, isSelf: false })).toBe(false);
  });

  it("does not re-pin on a downward move that stops short of the band", () => {
    expect(nextPinned(false, { distance: 60, deltaTop: 100, isSelf: false })).toBe(false);
  });

  it("does not re-pin an unpinned view on a clamp from content shrink", () => {
    expect(nextPinned(false, { distance: 0, deltaTop: -50, isSelf: false })).toBe(false);
  });

  it("re-pins inside the rubber-band overshoot (negative distance, moving down)", () => {
    expect(nextPinned(false, { distance: -8, deltaTop: 20, isSelf: false })).toBe(true);
  });

  it("honors a custom threshold", () => {
    expect(nextPinned(true, { distance: 30, deltaTop: -5, isSelf: false, threshold: 10 })).toBe(false);
    expect(nextPinned(false, { distance: 5, deltaTop: 5, isSelf: false, threshold: 10 })).toBe(true);
  });
});

describe("followStep", () => {
  it("moves toward the target without overshooting", () => {
    const next = followStep(0, 1000, 16);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(1000);
  });

  it("scales the step with dt (frame-rate independence)", () => {
    const slow = followStep(0, 1000, 8);
    const fast = followStep(0, 1000, 32);
    expect(fast).toBeGreaterThan(slow);
  });

  it("snaps to the target within snapPx", () => {
    expect(followStep(999.5, 1000, 16)).toBe(1000);
    expect(followStep(995, 1000, 16, { snapPx: 5 })).toBe(1000);
  });

  it("converges to the target over successive frames", () => {
    let pos = 0;
    for (let i = 0; i < 120; i++) pos = followStep(pos, 1000, 16);
    expect(pos).toBe(1000);
  });

  it("works upward too (target above current)", () => {
    const next = followStep(1000, 0, 16);
    expect(next).toBeLessThan(1000);
    expect(next).toBeGreaterThan(0);
  });
});
