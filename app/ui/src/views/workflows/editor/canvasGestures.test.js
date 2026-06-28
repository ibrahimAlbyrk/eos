import { describe, it, expect } from "vitest";
import {
  clampZoom,
  zoomAtPoint,
  wheelZoomFactor,
  normalizeRect,
  rectsIntersect,
  nodesInMarquee,
  snapToGrid,
  edgesForDisplay,
  MIN_ZOOM,
  MAX_ZOOM,
} from "./canvasGestures.js";
import { screenToFlow } from "./viewport.js";

describe("canvasGestures — zoom bounds", () => {
  it("clamps to [MIN_ZOOM, MAX_ZOOM]", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(1.25)).toBe(1.25);
  });

  it("respects custom bounds", () => {
    expect(clampZoom(5, 1, 2)).toBe(2);
    expect(clampZoom(0.5, 1, 2)).toBe(1);
  });
});

describe("canvasGestures — zoomAtPoint keeps the flow point under the cursor fixed", () => {
  it("the flow coord beneath the cursor is identical before and after zoom", () => {
    const vp = { x: 120, y: -40, zoom: 1 };
    const pane = { x: 300, y: 200 };
    const before = screenToFlow(vp, pane);
    const next = zoomAtPoint(vp, pane, 1.5);
    const after = screenToFlow(next, pane);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(next.zoom).toBeCloseTo(1.5, 9);
  });

  it("clamps the resulting zoom and still pins the point", () => {
    const vp = { x: 0, y: 0, zoom: 2.4 };
    const pane = { x: 50, y: 80 };
    const before = screenToFlow(vp, pane);
    const next = zoomAtPoint(vp, pane, 4); // 2.4*4 → clamps to MAX_ZOOM
    expect(next.zoom).toBe(MAX_ZOOM);
    const after = screenToFlow(next, pane);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it("zooming out then back in round-trips the viewport", () => {
    const vp = { x: 33, y: 77, zoom: 1 };
    const pane = { x: 210, y: 140 };
    const out = zoomAtPoint(vp, pane, 0.5);
    const back = zoomAtPoint(out, pane, 2);
    expect(back.x).toBeCloseTo(vp.x, 6);
    expect(back.y).toBeCloseTo(vp.y, 6);
    expect(back.zoom).toBeCloseTo(vp.zoom, 9);
  });
});

describe("canvasGestures — wheelZoomFactor", () => {
  it("scroll up (negative deltaY) zooms in (>1), down zooms out (<1)", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });
});

describe("canvasGestures — normalizeRect", () => {
  it("yields a non-negative-size box regardless of drag direction", () => {
    expect(normalizeRect({ x: 10, y: 10 }, { x: 4, y: 25 })).toEqual({ x: 4, y: 10, w: 6, h: 15 });
    expect(normalizeRect({ x: 0, y: 0 }, { x: 5, y: 5 })).toEqual({ x: 0, y: 0, w: 5, h: 5 });
  });
});

describe("canvasGestures — rectsIntersect", () => {
  it("overlapping rects intersect", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });
  it("fully-disjoint rects do not", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 })).toBe(false);
  });
  it("edge-touching counts as disjoint (strict)", () => {
    expect(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);
  });
});

describe("canvasGestures — snapToGrid", () => {
  it("rounds a coordinate to the nearest grid line", () => {
    expect(snapToGrid(10, 22)).toBe(0);
    expect(snapToGrid(12, 22)).toBe(22);
    expect(snapToGrid(40, 22)).toBe(44);
    expect(snapToGrid(-5, 22)).toBeCloseTo(0, 9);
    expect(snapToGrid(-15, 22)).toBe(-22);
  });
});

describe("canvasGestures — nodesInMarquee (partial overlap, like SelectionMode.Partial)", () => {
  const nodes = [
    { id: "a", box: { x: 0, y: 0, w: 100, h: 50 } },
    { id: "b", box: { x: 200, y: 200, w: 100, h: 50 } },
    { id: "c", box: { x: 90, y: 40, w: 100, h: 50 } },
  ];

  it("selects nodes the marquee partially overlaps", () => {
    // a box at (50,20)..(120,60) clips into a and c, misses b.
    expect(nodesInMarquee(nodes, { x: 50, y: 20, w: 70, h: 40 }).sort()).toEqual(["a", "c"]);
  });

  it("selects nothing when the marquee is empty space", () => {
    expect(nodesInMarquee(nodes, { x: 400, y: 400, w: 10, h: 10 })).toEqual([]);
  });

  it("ignores nodes without a box", () => {
    expect(nodesInMarquee([{ id: "x" }], { x: 0, y: 0, w: 999, h: 999 })).toEqual([]);
  });
});

describe("canvasGestures — edgesForDisplay (hide the edge being reconnected)", () => {
  const edges = [{ id: "e-1" }, { id: "e-2" }, { id: "e-3" }];

  it("returns every edge when no reconnect is in flight", () => {
    expect(edgesForDisplay(edges, null)).toEqual(edges);
    expect(edgesForDisplay(edges, undefined)).toEqual(edges);
  });

  it("drops the edge whose endpoint is being dragged so only the rubber-band shows", () => {
    expect(edgesForDisplay(edges, "e-2").map((e) => e.id)).toEqual(["e-1", "e-3"]);
  });

  it("is a no-op when the reconnect id matches no edge", () => {
    expect(edgesForDisplay(edges, "e-9")).toEqual(edges);
  });

  it("tolerates a missing edge list", () => {
    expect(edgesForDisplay(undefined, "e-1")).toEqual([]);
    expect(edgesForDisplay(null, null)).toEqual([]);
  });
});
