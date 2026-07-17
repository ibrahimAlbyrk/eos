import { describe, it, expect } from "vitest";
import {
  PANEL_CAP, MAX_COLS, COL_CAP, DEFAULT_RATIOS, DEFAULT_V, emptyDock,
  openPanelTile, closePanelTile, updatePanelTileData,
  hasPanelTile, panelTileData, panelTypes, setDockRatio,
  columnize, columnBounds, computePanelRects, computePanelHandles,
  clampRatio, clampSplit, clampBoundary, canFitColumns,
} from "./panelTiling.js";

const types = (dock) => panelTypes(dock);
const SIX = ["file", "diff", "terminal", "commits", "gitdiff", "agent"];
const fill = (names) => names.reduce((d, t) => openPanelTile(d, t, {}).dock, emptyDock());

// %-rect / handle fields go through fractional math, so compare field-wise with
// toBeCloseTo to stay float-safe.
const rectCloseTo = (actual, exp) => {
  expect(actual.left).toBeCloseTo(exp.left);
  expect(actual.top).toBeCloseTo(exp.top);
  expect(actual.width).toBeCloseTo(exp.width);
  expect(actual.height).toBeCloseTo(exp.height);
};
const handleCloseTo = (h, exp) => {
  expect(h.id).toBe(exp.id);
  expect(h.axis).toBe(exp.axis);
  expect(h.pos).toBeCloseTo(exp.pos);
  expect(h.cross).toBeCloseTo(exp.cross);
  expect(h.crossLen).toBeCloseTo(exp.crossLen);
};

describe("cap constants", () => {
  it("PANEL_CAP is MAX_COLS × COL_CAP = 6", () => {
    expect(MAX_COLS).toBe(3);
    expect(COL_CAP).toBe(2);
    expect(PANEL_CAP).toBe(6);
  });
});

describe("openPanelTile", () => {
  it("appends the first panel", () => {
    const { dock, evicted } = openPanelTile(emptyDock(), "file", { path: "/a" });
    expect(types(dock)).toEqual(["file"]);
    expect(panelTileData(dock, "file")).toEqual({ path: "/a" });
    expect(evicted).toBeNull();
  });

  it("grows the dock by appending distinct types up to the cap (no evict)", () => {
    const d = fill(SIX);
    expect(types(d)).toEqual(SIX);
    expect(d.slots.length).toBe(6);
  });

  it("reuses a same-type panel IN PLACE (data swap, slot index kept, no evict)", () => {
    let d = emptyDock();
    d = openPanelTile(d, "file", { path: "/a" }).dock;
    d = openPanelTile(d, "diff", {}).dock;
    const r = openPanelTile(d, "file", { path: "/b" });
    expect(types(r.dock)).toEqual(["file", "diff"]); // file stays at index 0
    expect(panelTileData(r.dock, "file")).toEqual({ path: "/b" });
    expect(r.evicted).toBeNull();
  });

  it("evicts the MOST-recently-opened slot when a 7th distinct type opens", () => {
    const d = fill(SIX); // agent = seq 5, slot 5 (most recent)
    const r = openPanelTile(d, "memory", {}); // evicts agent, takes slot 5
    expect(r.evicted).toBe("agent");
    expect(types(r.dock)).toEqual(["file", "diff", "terminal", "commits", "gitdiff", "memory"]);
  });

  it("revolves the last-opened slot: the five earlier panels stay pinned", () => {
    let d = fill(SIX);
    d = openPanelTile(d, "memory", {}).dock; // memory replaces agent (slot 5)
    const r = openPanelTile(d, "search", {}); // memory is now most-recent → evicted
    expect(r.evicted).toBe("memory");
    expect(types(r.dock)).toEqual(["file", "diff", "terminal", "commits", "gitdiff", "search"]);
  });

  it("reuse bumps recency, so a reused panel becomes the next eviction target", () => {
    let d = fill(SIX);
    d = openPanelTile(d, "file", { path: "/x" }).dock; // reuse file → now most recent (slot 0)
    const r = openPanelTile(d, "memory", {}); // file is most-recent → evicted from slot 0
    expect(r.evicted).toBe("file");
    expect(types(r.dock)).toEqual(["memory", "diff", "terminal", "commits", "gitdiff", "agent"]);
  });

  it("never exceeds the cap", () => {
    let d = emptyDock();
    for (const t of [...SIX, "memory", "search"]) {
      d = openPanelTile(d, t, {}).dock;
      expect(d.slots.length).toBeLessThanOrEqual(PANEL_CAP);
    }
    expect(d.slots.length).toBe(PANEL_CAP);
  });

  it("does not mutate the input dock", () => {
    const d = emptyDock();
    openPanelTile(d, "file", {});
    expect(d.slots).toEqual([]);
    expect(d.nextSeq).toBe(0);
  });
});

describe("closePanelTile", () => {
  it("removes the slot and reflows later slots down", () => {
    const d = fill(["file", "diff", "terminal"]);
    const r = closePanelTile(d, "diff");
    expect(r.closed).toBe(true);
    expect(types(r.dock)).toEqual(["file", "terminal"]);
  });

  it("returns the same dock reference when the type is absent", () => {
    const d = openPanelTile(emptyDock(), "file", {}).dock;
    const r = closePanelTile(d, "diff");
    expect(r.closed).toBe(false);
    expect(r.dock).toBe(d);
  });
});

describe("updatePanelTileData", () => {
  it("updates a slot's data in place", () => {
    let d = emptyDock();
    d = openPanelTile(d, "agent", { toolUseId: "t1", status: "running" }).dock;
    d = openPanelTile(d, "file", {}).dock;
    const next = updatePanelTileData(d, "agent", (data) => ({ ...data, status: "done" }));
    expect(panelTileData(next, "agent").status).toBe("done");
    expect(types(next)).toEqual(["agent", "file"]);
  });

  it("returns same ref when type absent or data unchanged", () => {
    const d = openPanelTile(emptyDock(), "agent", { a: 1 }).dock;
    expect(updatePanelTileData(d, "file", (x) => x)).toBe(d);
    expect(updatePanelTileData(d, "agent", (x) => x)).toBe(d);
  });
});

describe("hasPanelTile / panelTileData", () => {
  it("reports membership and data", () => {
    const d = openPanelTile(emptyDock(), "diff", { workerId: "w1" }).dock;
    expect(hasPanelTile(d, "diff")).toBe(true);
    expect(hasPanelTile(d, "file")).toBe(false);
    expect(panelTileData(d, "diff")).toEqual({ workerId: "w1" });
    expect(panelTileData(d, "file")).toBeNull();
  });
});

describe("setDockRatio", () => {
  it("sets and clamps a ratio", () => {
    let d = emptyDock();
    d = setDockRatio(d, "v1", 0.7);
    expect(d.ratios.v1).toBe(0.7);
    d = setDockRatio(d, "c0", 0.99);
    expect(d.ratios.c0).toBe(0.85); // clamped to RATIO_MAX
  });

  it("returns the same ref when unchanged", () => {
    const d = setDockRatio(emptyDock(), "v0", 0.5);
    expect(setDockRatio(d, "v0", 0.5)).toBe(d);
  });
});

describe("columnize", () => {
  it("groups slot indices into columns of ≤2", () => {
    expect(columnize(0)).toEqual([]);
    expect(columnize(1)).toEqual([[0]]);
    expect(columnize(2)).toEqual([[0, 1]]);
    expect(columnize(3)).toEqual([[0, 1], [2]]);
    expect(columnize(4)).toEqual([[0, 1], [2, 3]]);
    expect(columnize(5)).toEqual([[0, 1], [2, 3], [4]]);
    expect(columnize(6)).toEqual([[0, 1], [2, 3], [4, 5]]);
  });
});

describe("columnBounds", () => {
  it("1 column → no interior boundary", () => {
    expect(columnBounds(2)).toEqual({ C: 1, xs: [0, 1] });
  });

  it("2 columns default → midpoint split", () => {
    const { C, xs } = columnBounds(3);
    expect(C).toBe(2);
    expect(xs[1]).toBeCloseTo(0.5);
  });

  it("3 columns default → even thirds", () => {
    const { C, xs } = columnBounds(5);
    expect(C).toBe(3);
    expect(xs[1]).toBeCloseTo(1 / 3);
    expect(xs[2]).toBeCloseTo(2 / 3);
  });

  it("honors stored boundaries", () => {
    const { xs } = columnBounds(6, { c0: 0.3, c1: 0.6 });
    expect(xs[1]).toBeCloseTo(0.3);
    expect(xs[2]).toBeCloseTo(0.6);
  });

  it("clamps a stale boundary that would invert a column, keeping xs strictly increasing", () => {
    const { xs } = columnBounds(6, { c0: 0.9, c1: 0.1 });
    expect(xs[1]).toBeCloseTo(0.8); // c0 capped so 2 columns still fit to its right
    expect(xs[2]).toBeCloseTo(0.9); // c1 floored above c0
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(xs[2]).toBeLessThan(xs[3]);
  });
});

describe("computePanelRects", () => {
  const slots = (...t) => t.map((type) => ({ type, data: {}, seq: 0 }));

  it("empty → no rects", () => {
    expect(computePanelRects(slots())).toEqual([]);
  });

  it("1 panel fills the dock", () => {
    expect(computePanelRects(slots("file"))).toEqual([
      { type: "file", rect: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
  });

  it("2 panels stack top/bottom by v0", () => {
    const r = computePanelRects(slots("file", "diff"), { v0: 0.5 });
    expect(r.map((x) => x.type)).toEqual(["file", "diff"]);
    rectCloseTo(r[0].rect, { left: 0, top: 0, width: 100, height: 50 });
    rectCloseTo(r[1].rect, { left: 0, top: 50, width: 100, height: 50 });
  });

  it("2 panels honor a custom v0 ratio", () => {
    const r = computePanelRects(slots("file", "diff"), { v0: 0.7 });
    expect(r[0].rect.height).toBeCloseTo(70);
    expect(r[1].rect.top).toBeCloseTo(70);
    expect(r[1].rect.height).toBeCloseTo(30);
  });

  it("3 panels: left stacked pair (col 0) + full-height right single (col 1)", () => {
    const r = computePanelRects(slots("file", "diff", "terminal"), { v0: 0.5, c0: 0.6 });
    rectCloseTo(r[0].rect, { left: 0, top: 0, width: 60, height: 50 });
    rectCloseTo(r[1].rect, { left: 0, top: 50, width: 60, height: 50 });
    rectCloseTo(r[2].rect, { left: 60, top: 0, width: 40, height: 100 });
  });

  it("4 panels: two stacked columns (default midpoint boundary)", () => {
    const r = computePanelRects(slots("file", "diff", "terminal", "commits"), { v0: 0.5, v1: 0.5 });
    rectCloseTo(r[0].rect, { left: 0, top: 0, width: 50, height: 50 });
    rectCloseTo(r[1].rect, { left: 0, top: 50, width: 50, height: 50 });
    rectCloseTo(r[2].rect, { left: 50, top: 0, width: 50, height: 50 });
    rectCloseTo(r[3].rect, { left: 50, top: 50, width: 50, height: 50 });
  });

  it("5 panels: two stacked columns + full-height right single", () => {
    const r = computePanelRects(
      slots("a", "b", "c", "d", "e"),
      { v0: 0.5, v1: 0.5, c0: 0.3, c1: 0.6 },
    );
    rectCloseTo(r[0].rect, { left: 0, top: 0, width: 30, height: 50 });
    rectCloseTo(r[1].rect, { left: 0, top: 50, width: 30, height: 50 });
    rectCloseTo(r[2].rect, { left: 30, top: 0, width: 30, height: 50 });
    rectCloseTo(r[3].rect, { left: 30, top: 50, width: 30, height: 50 });
    rectCloseTo(r[4].rect, { left: 60, top: 0, width: 40, height: 100 });
  });

  it("6 panels: three stacked columns", () => {
    const r = computePanelRects(
      slots("a", "b", "c", "d", "e", "f"),
      { v0: 0.5, v1: 0.5, v2: 0.5, c0: 0.3, c1: 0.6 },
    );
    rectCloseTo(r[0].rect, { left: 0, top: 0, width: 30, height: 50 });
    rectCloseTo(r[1].rect, { left: 0, top: 50, width: 30, height: 50 });
    rectCloseTo(r[2].rect, { left: 30, top: 0, width: 30, height: 50 });
    rectCloseTo(r[3].rect, { left: 30, top: 50, width: 30, height: 50 });
    rectCloseTo(r[4].rect, { left: 60, top: 0, width: 40, height: 50 });
    rectCloseTo(r[5].rect, { left: 60, top: 50, width: 40, height: 50 });
  });

  it("clamps out-of-range ratios", () => {
    const r = computePanelRects(slots("a", "b"), { v0: 2 });
    expect(r[0].rect.height).toBeCloseTo(85); // v clamped to RATIO_MAX
  });
});

describe("computePanelHandles", () => {
  it("no handle for <2 panels", () => {
    expect(computePanelHandles(0)).toEqual([]);
    expect(computePanelHandles(1)).toEqual([]);
  });

  it("2 panels → one horizontal (y) handle spanning full width", () => {
    const h = computePanelHandles(2, { v0: 0.5 });
    expect(h.length).toBe(1);
    handleCloseTo(h[0], { id: "v0", axis: "y", pos: 50, cross: 0, crossLen: 100 });
  });

  it("3 panels → v0 spans the left column, c0 spans full height", () => {
    const h = computePanelHandles(3, { v0: 0.4, c0: 0.6 });
    expect(h.length).toBe(2);
    handleCloseTo(h[0], { id: "v0", axis: "y", pos: 40, cross: 0, crossLen: 60 });
    handleCloseTo(h[1], { id: "c0", axis: "x", pos: 60, cross: 0, crossLen: 100 });
  });

  it("4 panels → a v handle per column + one column boundary", () => {
    const h = computePanelHandles(4, { v0: 0.5, v1: 0.5 });
    expect(h.map((x) => x.id)).toEqual(["v0", "v1", "c0"]);
    handleCloseTo(h[0], { id: "v0", axis: "y", pos: 50, cross: 0, crossLen: 50 });
    handleCloseTo(h[1], { id: "v1", axis: "y", pos: 50, cross: 50, crossLen: 50 });
    handleCloseTo(h[2], { id: "c0", axis: "x", pos: 50, cross: 0, crossLen: 100 });
  });

  it("6 panels → three v handles + two column boundaries", () => {
    const h = computePanelHandles(6, { v0: 0.5, v1: 0.5, v2: 0.5, c0: 0.3, c1: 0.6 });
    expect(h.map((x) => x.id)).toEqual(["v0", "v1", "v2", "c0", "c1"]);
    handleCloseTo(h[0], { id: "v0", axis: "y", pos: 50, cross: 0, crossLen: 30 });
    handleCloseTo(h[1], { id: "v1", axis: "y", pos: 50, cross: 30, crossLen: 30 });
    handleCloseTo(h[2], { id: "v2", axis: "y", pos: 50, cross: 60, crossLen: 40 });
    handleCloseTo(h[3], { id: "c0", axis: "x", pos: 30, cross: 0, crossLen: 100 });
    handleCloseTo(h[4], { id: "c1", axis: "x", pos: 60, cross: 0, crossLen: 100 });
  });

  it("5 panels → v handles only for the two stacked columns (single last column has none)", () => {
    const h = computePanelHandles(5, { v0: 0.5, v1: 0.5, c0: 0.3, c1: 0.6 });
    expect(h.map((x) => x.id)).toEqual(["v0", "v1", "c0", "c1"]);
  });
});

describe("clampRatio", () => {
  it("clamps to [0.15, 0.85]", () => {
    expect(clampRatio(0.01)).toBe(0.15);
    expect(clampRatio(0.99)).toBe(0.85);
    expect(clampRatio(0.5)).toBe(0.5);
  });
});

describe("clampSplit (px-min two-sided)", () => {
  it("passes a comfortable frac through", () => {
    expect(clampSplit(0.5, 100, 100, 1000)).toBeCloseTo(0.5);
  });

  it("stops at the low bound so panel A keeps its min", () => {
    expect(clampSplit(0.1, 300, 100, 1000)).toBeCloseTo(0.3);
  });

  it("stops at the high bound so panel B keeps its min", () => {
    expect(clampSplit(0.95, 100, 300, 1000)).toBeCloseTo(0.7);
  });

  it("falls back to the fractional clamp when container size is unknown", () => {
    expect(clampSplit(0.99, 100, 100, 0)).toBe(0.85);
  });

  it("freezes at a stable proportional split when both mins can't fit", () => {
    const f = clampSplit(0.1, 400, 400, 500);
    expect(f).toBeCloseTo(0.5);
    expect(clampSplit(0.9, 400, 400, 500)).toBeCloseTo(f);
  });
});

describe("clampBoundary (neighbor-aware column boundary)", () => {
  it("with edge bounds (0..1) behaves like clampSplit", () => {
    expect(clampBoundary(0.5, 100, 100, 1000)).toBeCloseTo(0.5);
    expect(clampBoundary(0.1, 300, 100, 1000)).toBeCloseTo(0.3);
    expect(clampBoundary(0.95, 100, 300, 1000)).toBeCloseTo(0.7);
  });

  it("a middle boundary can't cross its left neighbor", () => {
    // neighbor lo = 0.33; keep left column's 100px min → lo = 0.33 + 0.1
    expect(clampBoundary(0.1, 100, 100, 1000, 0.33, 1)).toBeCloseTo(0.43);
  });

  it("a middle boundary can't cross its right neighbor", () => {
    // neighbor hi = 0.67; keep right column's 100px min → hi = 0.67 - 0.1
    expect(clampBoundary(0.99, 100, 100, 1000, 0, 0.67)).toBeCloseTo(0.57);
  });

  it("falls back to the fractional clamp when container size is unknown", () => {
    expect(clampBoundary(0.99, 100, 100, 0, 0.2, 0.8)).toBe(0.85);
  });

  it("freezes proportionally between the neighbor bounds when mins can't fit", () => {
    const f = clampBoundary(0.1, 400, 400, 500, 0, 1);
    expect(f).toBeCloseTo(0.5);
    expect(clampBoundary(0.9, 400, 400, 500, 0, 1)).toBeCloseTo(f);
  });
});

describe("canFitColumns", () => {
  it("true when the dock is wide enough for every column minimum", () => {
    expect(canFitColumns(700, [300, 300])).toBe(true);
    expect(canFitColumns(600, [300, 300])).toBe(true);
    expect(canFitColumns(900, [300, 300, 300])).toBe(true);
  });

  it("false when the dock is too narrow", () => {
    expect(canFitColumns(500, [300, 300])).toBe(false);
    expect(canFitColumns(800, [300, 300, 300])).toBe(false);
  });
});

describe("DEFAULT_RATIOS", () => {
  it("defaults each column's vertical split to a balanced DEFAULT_V", () => {
    expect(DEFAULT_V).toBe(0.5);
    expect(DEFAULT_RATIOS).toEqual({ v0: 0.5, v1: 0.5, v2: 0.5 });
  });
});
