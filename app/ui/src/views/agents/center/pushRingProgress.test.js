import { describe, it, expect } from "vitest";
import { trickleKeyframes } from "./pushRingProgress.js";

const CAP = 0.88;
const DUR = 9000;
const TAU = 1800;
const STEPS = 16;

const offsets = () =>
  trickleKeyframes(CAP, DUR, TAU, STEPS).map((f) => f.strokeDashoffset);

describe("trickleKeyframes", () => {
  it("starts fully hidden", () => {
    expect(offsets()[0]).toBe(1);
  });

  it("yields steps+1 frames", () => {
    expect(offsets()).toHaveLength(STEPS + 1);
  });

  it("only ever moves forward", () => {
    const o = offsets();
    for (let i = 1; i < o.length; i++) expect(o[i]).toBeLessThan(o[i - 1]);
  });

  it("never reaches full — parks just above the cap asymptote", () => {
    const last = offsets().at(-1);
    expect(last).toBeGreaterThan(1 - CAP);
    expect(last).toBeLessThan(1 - CAP + 0.02);
  });

  it("decelerates: first segment far faster than last", () => {
    const o = offsets();
    const first = o[0] - o[1];
    const last = o[o.length - 2] - o[o.length - 1];
    expect(first).toBeGreaterThan(last * 5);
  });
});
