import { describe, it, expect } from "vitest";
import { createWheelAccumulator, sgrWheelReports } from "./mouseWheel.js";

const px = (deltaY) => ({ deltaY, deltaMode: 0 });

describe("createWheelAccumulator", () => {
  it("emits one step per cell height of pixel travel", () => {
    const acc = createWheelAccumulator(1);
    expect(acc(px(40), 20, 30)).toBe(2);
    expect(acc(px(-60), 20, 30)).toBe(-3);
  });
  it("carries the sub-line remainder across events", () => {
    const acc = createWheelAccumulator(1);
    expect(acc(px(8), 20, 30)).toBe(0);
    expect(acc(px(8), 20, 30)).toBe(0);
    expect(acc(px(8), 20, 30)).toBe(1);
  });
  it("drops the remainder on a direction flip", () => {
    const acc = createWheelAccumulator(1);
    acc(px(15), 20, 30);
    expect(acc(px(-15), 20, 30)).toBe(0);
    expect(acc(px(-10), 20, 30)).toBe(-1);
  });
  it("handles line and page delta modes", () => {
    const acc = createWheelAccumulator(1);
    expect(acc({ deltaY: 3, deltaMode: 1 }, 20, 30)).toBe(3);
    expect(acc({ deltaY: -1, deltaMode: 2 }, 20, 30)).toBe(-30);
  });
  it("scales travel by the speed factor", () => {
    const acc = createWheelAccumulator(0.5);
    expect(acc(px(40), 20, 30)).toBe(1);
    expect(acc(px(20), 20, 30)).toBe(0);
    expect(acc(px(20), 20, 30)).toBe(1);
  });
});

describe("sgrWheelReports", () => {
  it("repeats the SGR wheel report per step", () => {
    expect(sgrWheelReports(-2, 5, 7)).toBe("\x1b[<64;5;7M\x1b[<64;5;7M");
    expect(sgrWheelReports(1, 1, 1)).toBe("\x1b[<65;1;1M");
    expect(sgrWheelReports(0, 1, 1)).toBe("");
  });
});
