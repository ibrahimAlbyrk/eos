import { describe, it, expect } from "vitest";
import { flightSpring } from "./sendFlight.js";

describe("flightSpring", () => {
  const samples = Array.from({ length: 101 }, (_, i) => flightSpring(i / 100));

  it("starts on the composer and ends exactly on the bubble", () => {
    expect(samples[0]).toBe(0);
    expect(samples[100]).toBe(1);
    expect(flightSpring(1.5)).toBe(1);
  });

  it("overshoots the slot only slightly", () => {
    const peak = Math.max(...samples);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.04);
  });

  it("is already near rest before the hand-off snaps it", () => {
    expect(Math.abs(samples[99] - 1)).toBeLessThan(0.005);
  });
});
