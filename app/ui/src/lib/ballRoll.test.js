import { describe, it, expect } from "vitest";
import { decalInk, nextRest, restAngle, rocketEase, wrapAngle } from "./ballRoll.js";

const PI = Math.PI;

describe("rocketEase", () => {
  const samples = Array.from({ length: 101 }, (_, i) => rocketEase(i / 100));

  it("starts at rest and lands exactly", () => {
    expect(samples[0]).toBe(0);
    expect(samples[100]).toBe(1);
    expect(rocketEase(-1)).toBe(0);
    expect(rocketEase(2)).toBe(1);
  });

  it("never overshoots or turns back", () => {
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
      expect(samples[i]).toBeLessThanOrEqual(1);
    }
  });

  it("ignites slowly, then accelerates hard", () => {
    expect(samples[20]).toBeLessThan(0.05);
    expect(samples[60] - samples[40]).toBeGreaterThan(0.4);
  });
});

describe("nextRest", () => {
  it("rolls half a turn forward on each flip", () => {
    expect(nextRest(0, true)).toBeCloseTo(PI);
    expect(nextRest(PI, false)).toBeCloseTo(2 * PI);
  });

  it("keeps rolling forward when interrupted mid-roll", () => {
    expect(nextRest(1, false)).toBeCloseTo(2 * PI);
    expect(nextRest(4, true)).toBeCloseTo(3 * PI);
  });

  it("never picks an angle behind the ball", () => {
    for (let theta = -7; theta < 7; theta += 0.37) {
      expect(nextRest(theta, true)).toBeGreaterThan(theta);
      expect(nextRest(theta, false)).toBeGreaterThan(theta);
    }
  });

  it("lands on the face for the mode once wrapped", () => {
    expect(wrapAngle(nextRest(0, true))).toBeCloseTo(restAngle(true));
    expect(wrapAngle(nextRest(PI, false))).toBeCloseTo(restAngle(false));
  });
});

describe("decalInk", () => {
  const aa = 0.02;

  it("prints the arrow on the front pole", () => {
    expect(decalInk(0, 0, 1, aa)).toBe(1); // the shaft
    expect(decalInk(0.2, 0.2, 0.96, aa)).toBe(0); // beside the head
  });

  it("prints the stop square on the back pole", () => {
    expect(decalInk(0, 0, -1, aa)).toBe(1);
    expect(decalInk(0.2, 0.2, -0.96, aa)).toBe(1); // inside, near a corner
    expect(decalInk(0.26, 0.26, -0.93, aa)).toBe(0); // cut off by the rounded corner
  });

  it("points the arrow up (screen y grows downward)", () => {
    expect(decalInk(-0.1025, -0.132, 0.98, aa)).toBe(1); // mid left arm
    expect(decalInk(-0.1025, 0.132, 0.98, aa)).toBe(0); // its mirror below
  });
});
