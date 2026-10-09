import { describe, it, expect } from "vitest";
import {
  areaBetween,
  areaPath,
  bandXs,
  barPath,
  chartData,
  donutSegments,
  labelStride,
  linePath,
  nearestIndex,
  niceScale,
  numericFields,
  pointXs,
  scaleY,
  valueExtent,
} from "./chartGeom.js";

const runs = [
  { run: "r38", t: 31.2, fails: 1 },
  { run: "r39", t: 33.0, fails: 0 },
  { run: "r40", t: null, fails: 2 },
  { run: "r41", t: 34.3, fails: 0 },
];

describe("chartData", () => {
  it("takes labels from x= and series from y=", () => {
    const d = chartData(runs, { x: "run", y: ["t", "fails"] });
    expect(d.labels).toEqual(["r38", "r39", "r40", "r41"]);
    expect(d.series.map((s) => s.key)).toEqual(["t", "fails"]);
    expect(d.series[0].values).toEqual([31.2, 33, null, 34.3]);
  });

  it("guesses x and the first numeric field when they are left out", () => {
    const d = chartData([{ day: "Mo", n: 4 }, { day: "Tu", n: 6 }], {});
    expect(d.labels).toEqual(["Mo", "Tu"]);
    expect(d.series).toEqual([{ key: "n", values: [4, 6] }]);
    expect(numericFields(runs, ["run"])).toEqual(["t", "fails"]);
    expect(numericFields([{ a: 1 }, { a: "x" }])).toEqual([]);
  });

  it("reads a plain values= list", () => {
    const d = chartData(null, { values: [20, "18", 22] });
    expect(d.labels).toEqual(["1", "2", "3"]);
    expect(d.series[0].values).toEqual([20, 18, 22]);
    expect(chartData(null, {}).series).toEqual([]);
  });
});

describe("scales", () => {
  it("niceScale rounds to 1/2/5 steps around the data", () => {
    expect(niceScale(31.2, 34.3, 3)).toEqual({ min: 31, max: 35, step: 1, ticks: [31, 32, 33, 34, 35] });
    const s = niceScale(0, 9400, 4);
    expect(s.step).toBe(2000);
    expect(s.ticks[0]).toBe(0);
    expect(s.ticks.at(-1)).toBe(10000);
    const flat = niceScale(5, 5, 4);
    expect(flat.min).toBeLessThanOrEqual(5);
    expect(flat.max).toBeGreaterThan(5);
  });

  it("valueExtent stands bars on zero and sums stacks", () => {
    const series = [{ values: [1, 4] }, { values: [2, 3] }];
    expect(valueExtent(series)).toEqual([1, 4]);
    expect(valueExtent(series, { zero: true })).toEqual([0, 4]);
    expect(valueExtent(series, { stacked: true })).toEqual([3, 7]);
    expect(valueExtent([{ values: [null] }])).toEqual([0, 1]);
  });

  it("maps values and positions", () => {
    expect(scaleY(0, 0, 10, 10, 110)).toBe(110);
    expect(scaleY(10, 0, 10, 10, 110)).toBe(10);
    expect(pointXs(3, 0, 100)).toEqual([0, 50, 100]);
    expect(pointXs(1, 0, 100)).toEqual([50]);
    const b = bandXs(4, 0, 400);
    expect(b.xs).toEqual([50, 150, 250, 350]);
    expect(b.bar).toBeCloseTo(72);
    expect(nearestIndex([0, 50, 100], 70)).toBe(1);
    expect(labelStride(30, 560)).toBe(3);
    expect(labelStride(6, 560)).toBe(1);
  });
});

describe("paths", () => {
  it("linePath breaks on gaps, areaPath closes each run on the baseline", () => {
    const pts = [{ x: 0, y: 10 }, { x: 10, y: 5 }, null, { x: 30, y: 8 }];
    expect(linePath(pts)).toBe("M0 10 L10 5 M30 8");
    expect(areaPath(pts, 20)).toBe("M0 20 L0 10 L10 5 L10 20 Z M30 20 L30 8 L30 20 Z");
    expect(areaBetween([{ x: 0, y: 1 }, { x: 1, y: 2 }], [{ x: 0, y: 5 }, { x: 1, y: 5 }])).toBe("M0 1 L1 2 L1 5 L0 5 Z");
  });

  it("barPath rounds the top more than the bottom and skips empty bars", () => {
    const d = barPath(0, 0, 20, 50);
    expect(d.startsWith("M0 6 Q0 0 6 0")).toBe(true);
    expect(d).toContain("L20 48 Q20 50 18 50");
    expect(barPath(0, 0, 20, 0)).toBe("");
  });

  it("donut segments add up and start at 12 o'clock", () => {
    const segs = donutSegments([48, 34, 18]);
    expect(segs.map((s) => s.dash)).toEqual(["48 52", "34 66", "18 82"]);
    expect(segs.map((s) => s.offset)).toEqual([25, -23, -57]);
    expect(segs.reduce((a, s) => a + s.frac, 0)).toBeCloseTo(1);
    expect(donutSegments([0, 0])).toEqual([]);
  });
});
