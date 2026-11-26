import { describe, it, expect } from "vitest";
import { discOf, placeDiscs, scaleOf, sizeOf } from "./placeDiscs.js";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

/// `n` routines of `tier`, named so their order is their number.
function routines(tier, n, extra = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${tier}-${i}`,
    name: `Routine ${tier}-${String(i).padStart(2, "0")}`,
    tier,
    needs: 0,
    running: false,
    fresh: false,
    nextAt: null,
    runs7d: 0,
    project: false,
    ...extra,
  }));
}

function field([one, two, three], W = 1440, H = 900) {
  const all = [...routines(1, one), ...routines(2, two), ...routines(3, three)];
  return placeDiscs(all, { W, H, inputWidth: Math.min(580, W - 64) });
}

const angles = (out, ring) => out.discs.filter((d) => d.ring === ring).map((d) => d.angle);
const plus = (out) => out.plusDiscs.map((p) => [p.ring, p.count, p.angle]);

describe("the disc of a routine", () => {
  it("is on ring 1 with Needs-you items or a problem, ring 2 while it works or has a fresh result, else ring 3", () => {
    const row = { id: "rt-1", name: "PR Review", state: "active", activeRuns: 0, runs7d: 4, kind: "standing" };
    expect(discOf(row, { needs: 2, now: NOW }).tier).toBe(1);
    expect(discOf({ ...row, state: "paused", pausedReason: "failures" }, { now: NOW }).tier).toBe(1);
    expect(discOf({ ...row, state: "paused", pausedReason: "user" }, { now: NOW }).tier).toBe(3);
    expect(discOf({ ...row, activeRuns: 1 }, { now: NOW }).tier).toBe(2);
    const fresh = { ...row, lastRun: { id: "rn-1", endedAt: NOW - 2 * HOUR } };
    expect(discOf(fresh, { now: NOW }).tier).toBe(2);
    expect(discOf(fresh, { now: NOW, opened: true }).tier).toBe(3);
    expect(discOf({ ...row, lastRun: { id: "rn-1", endedAt: NOW - 13 * HOUR } }, { now: NOW }).tier).toBe(3);
  });

  it("sizes by runs in the last 7 days within its tier's band, a project at 144, all times the scale", () => {
    const [quiet] = routines(3, 1);
    expect(sizeOf(quiet, 1)).toBe(76);
    expect(sizeOf({ ...quiet, runs7d: 50 }, 1)).toBe(84);
    expect(sizeOf({ ...quiet, runs7d: 500 }, 1)).toBe(84);
    expect(sizeOf({ ...quiet, tier: 1, runs7d: 50 }, 1)).toBe(124);
    expect(sizeOf({ ...quiet, project: true }, 1.25)).toBe(180);
    expect(scaleOf(1440, 900)).toBe(1);
    expect(scaleOf(800, 500)).toBe(0.8);
    expect(scaleOf(3000, 2000)).toBe(1.25);
  });

  it("orders a ring by Needs-you count, running before fresh, next run, then name", () => {
    const list = [
      { ...routines(1, 1)[0], id: "b", name: "B", needs: 1 },
      { ...routines(1, 1)[0], id: "a", name: "A", needs: 3 },
      { ...routines(2, 1)[0], id: "f", name: "F", fresh: true },
      { ...routines(2, 1)[0], id: "r", name: "R", running: true },
      { ...routines(3, 1)[0], id: "late", name: "Late", nextAt: NOW + 5 * HOUR },
      { ...routines(3, 1)[0], id: "soon", name: "Soon", nextAt: NOW + HOUR },
    ];
    const out = placeDiscs(list, { W: 1440, H: 900, inputWidth: 580 });
    expect(out.discs.map((d) => [d.id, d.angle])).toEqual([
      ["a", 245],
      ["b", 65.1],
      ["r", 325],
      ["f", 151.8],
      ["soon", 12],
      ["late", 197],
    ]);
  });
});

describe("placing discs at 1440 × 900", () => {
  it("holds 4, 4 and 8 discs, about 19 compact on ring 3", () => {
    const full = field([10, 10, 0]);
    expect(angles(full, 1)).toEqual([245, 65.1, 290]);
    expect(angles(full, 2)).toEqual([325, 151.8, 45.1]);
    expect(plus(full)).toEqual([
      [1, 7, 110.2],
      [2, 7, 231.8],
    ]);
    expect(angles(field([0, 0, 8]), 3)).toEqual([12, 197, 178.5, 30.5, 215.5, 344.9, 160, 326.4]);
    const compact = field([0, 0, 19]);
    expect(compact.discs.every((d) => d.compact && d.d === 60)).toBe(true);
    expect(compact.fits).toBe(true);
    expect(compact.discs).toHaveLength(19);
  });

  it("puts one routine at its ring's first angle", () => {
    expect(angles(field([1, 0, 0]), 1)).toEqual([245]);
    expect(angles(field([0, 1, 0]), 2)).toEqual([325]);
    expect(angles(field([0, 0, 1]), 3)).toEqual([12]);
    expect(field([1, 0, 0]).fits).toBe(true);
  });

  it("draws the design's six discs where it shows them", () => {
    const out = field([2, 2, 2]);
    expect([angles(out, 1), angles(out, 2), angles(out, 3)]).toEqual([
      [245, 65.1],
      [325, 151.8],
      [12, 197],
    ]);
    const [first] = out.discs;
    expect(Math.round(first.x)).toBe(-99);
    expect(Math.round(first.y)).toBe(-213);
    expect(out.ringLabels.map((l) => [l.text, l.hidden])).toEqual([
      ["Needs you", false],
      ["Working", false],
      ["Quiet", false],
    ]);
  });

  it("turns ring 3 compact at 15 and still fits", () => {
    const out = field([3, 3, 9]);
    expect(out.fits).toBe(true);
    expect(out.discs.filter((d) => d.ring === 3).every((d) => d.compact)).toBe(true);
    expect(out.discs.filter((d) => d.ring !== 3).some((d) => d.compact)).toBe(false);
  });

  it("gives ring 2 a +3 and ring 3 a +12 at 40, and opens the List", () => {
    const out = field([4, 6, 30]);
    expect(angles(out, 1)).toEqual([245, 65.1, 290, 110.2]);
    expect(plus(out)).toEqual([
      [2, 3, 231.8],
      [3, 12, 141],
    ]);
    expect(out.overflow).toEqual({ 1: 0, 2: 3, 3: 12 });
    expect(out.fits).toBe(false);
  });

  it("names each ring at its crest, or where it comes back into the window, and never under a disc", () => {
    const bare = placeDiscs([], { W: 1440, H: 900, inputWidth: 580 });
    expect(bare.ringLabels.map((l) => [Math.round(l.x) + 0, Math.round(l.y) + 0])).toEqual([
      [0, -235],
      [0, -390],
      [-429, -360],
    ]);
    const out = placeDiscs(routines(3, 3, 3), { W: 1440, H: 900, inputWidth: 580 });
    for (const label of out.ringLabels.filter((l) => !l.hidden)) {
      for (const disc of out.discs) expect(Math.hypot(label.x - disc.x, label.y - disc.y)).toBeGreaterThan(disc.d / 2);
    }
  });
});

describe("placing discs at 1920 × 1200", () => {
  it("scales the rings by 1.25 and keeps the order", () => {
    const out = field([2, 2, 2], 1920, 1200);
    expect([angles(out, 1), angles(out, 2), angles(out, 3)]).toEqual([
      [245, 63.4],
      [325, 135.2],
      [12, 189.3],
    ]);
    const crowded = field([4, 6, 30], 1920, 1200);
    expect(crowded.discs.filter((d) => d.ring === 2)).toHaveLength(6);
    expect(plus(crowded)).toEqual([[3, 4, 314.7]]);
  });
});

describe("placing discs at 800 × 500", () => {
  it("finds no slot clear of the input, so every count opens the List", () => {
    for (const counts of [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [2, 2, 2],
      [4, 6, 30],
    ]) {
      const out = field(counts, 800, 500);
      expect(out.discs).toEqual([]);
      expect(out.fits).toBe(false);
    }
  });
});
