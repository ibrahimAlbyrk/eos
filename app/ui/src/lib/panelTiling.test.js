import { describe, it, expect } from "vitest";
import {
  PANEL_CAP, DEFAULT_RATIOS, emptyDock,
  openPanelTile, closePanelTile, updatePanelTileData,
  hasPanelTile, panelTileData, panelTypes, setDockRatio,
  computePanelRects, computePanelHandles, clampRatio, clampSplit, canFitColumns,
} from "./panelTiling.js";

const types = (dock) => panelTypes(dock);

describe("openPanelTile", () => {
  it("appends the first panel", () => {
    const { dock, evicted } = openPanelTile(emptyDock(), "file", { path: "/a" });
    expect(types(dock)).toEqual(["file"]);
    expect(panelTileData(dock, "file")).toEqual({ path: "/a" });
    expect(evicted).toBeNull();
  });

  it("grows the dock 1→2→3 by appending distinct types", () => {
    let d = emptyDock();
    d = openPanelTile(d, "file", {}).dock;
    d = openPanelTile(d, "diff", {}).dock;
    d = openPanelTile(d, "terminal", {}).dock;
    expect(types(d)).toEqual(["file", "diff", "terminal"]);
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

  it("evicts the MOST-recently-opened slot when a 4th distinct type opens", () => {
    let d = emptyDock();
    d = openPanelTile(d, "file", {}).dock;    // seq 0, slot 0
    d = openPanelTile(d, "diff", {}).dock;    // seq 1, slot 1
    d = openPanelTile(d, "terminal", {}).dock; // seq 2, slot 2  (most recent)
    const r = openPanelTile(d, "commits", {}); // evicts terminal, takes slot 2
    expect(r.evicted).toBe("terminal");
    expect(types(r.dock)).toEqual(["file", "diff", "commits"]);
  });

  it("revolves the last-opened slot: the two earlier panels stay pinned", () => {
    let d = emptyDock();
    d = openPanelTile(d, "file", {}).dock;
    d = openPanelTile(d, "diff", {}).dock;
    d = openPanelTile(d, "terminal", {}).dock;
    d = openPanelTile(d, "commits", {}).dock; // commits replaces terminal (slot 2)
    const r = openPanelTile(d, "memory", {}); // commits is now most-recent → evicted
    expect(r.evicted).toBe("commits");
    expect(types(r.dock)).toEqual(["file", "diff", "memory"]);
  });

  it("reuse bumps recency, so a reused panel becomes the next eviction target", () => {
    let d = emptyDock();
    d = openPanelTile(d, "file", {}).dock;    // seq 0
    d = openPanelTile(d, "diff", {}).dock;    // seq 1
    d = openPanelTile(d, "terminal", {}).dock; // seq 2
    d = openPanelTile(d, "file", { path: "/x" }).dock; // reuse file, seq 3 (now most recent)
    const r = openPanelTile(d, "commits", {}); // file is most-recent → evicted from slot 0
    expect(r.evicted).toBe("file");
    expect(types(r.dock)).toEqual(["commits", "diff", "terminal"]);
  });

  it("never exceeds the cap", () => {
    let d = emptyDock();
    for (const t of ["file", "diff", "terminal", "commits", "memory", "agent"]) {
      d = openPanelTile(d, t, {}).dock;
      expect(d.slots.length).toBeLessThanOrEqual(PANEL_CAP);
    }
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
    let d = emptyDock();
    d = openPanelTile(d, "file", {}).dock;
    d = openPanelTile(d, "diff", {}).dock;
    d = openPanelTile(d, "terminal", {}).dock;
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
    d = setDockRatio(d, "v", 0.7);
    expect(d.ratios.v).toBe(0.7);
    d = setDockRatio(d, "col", 0.99);
    expect(d.ratios.col).toBe(0.85); // clamped to RATIO_MAX
  });

  it("returns the same ref when unchanged", () => {
    const d = setDockRatio(emptyDock(), "v", 0.5);
    expect(setDockRatio(d, "v", 0.5)).toBe(d);
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

  it("2 panels stack top/bottom by v", () => {
    const r = computePanelRects(slots("file", "diff"), { v: 0.5, col: 0.5 });
    expect(r).toEqual([
      { type: "file", rect: { left: 0, top: 0, width: 100, height: 50 } },
      { type: "diff", rect: { left: 0, top: 50, width: 100, height: 50 } },
    ]);
  });

  it("2 panels honor a custom v ratio", () => {
    const r = computePanelRects(slots("file", "diff"), { v: 0.7, col: 0.5 });
    expect(r[0].rect.height).toBeCloseTo(70);
    expect(r[1].rect.top).toBeCloseTo(70);
    expect(r[1].rect.height).toBeCloseTo(30);
  });

  it("3 panels: left column stacked pair + full-height right column", () => {
    const r = computePanelRects(slots("file", "diff", "terminal"), { v: 0.5, col: 0.6 });
    expect(r[0].rect).toEqual({ left: 0, top: 0, width: 60, height: 50 });
    expect(r[1].rect).toEqual({ left: 0, top: 50, width: 60, height: 50 });
    expect(r[2].rect).toEqual({ left: 60, top: 0, width: 40, height: 100 });
  });

  it("clamps out-of-range ratios", () => {
    const r = computePanelRects(slots("a", "b"), { v: 2, col: 0.5 });
    expect(r[0].rect.height).toBeCloseTo(85); // v clamped to RATIO_MAX
  });
});

describe("computePanelHandles", () => {
  it("no handle for <2 panels", () => {
    expect(computePanelHandles(0)).toEqual([]);
    expect(computePanelHandles(1)).toEqual([]);
  });

  it("2 panels → one horizontal (y) handle spanning full width", () => {
    const h = computePanelHandles(2, { v: 0.5, col: 0.5 });
    expect(h).toEqual([{ id: "v", axis: "y", pos: 50, cross: 0, crossLen: 100 }]);
  });

  it("3 panels → v handle spans the left column, col handle full height", () => {
    const h = computePanelHandles(3, { v: 0.4, col: 0.6 });
    expect(h).toEqual([
      { id: "v", axis: "y", pos: 40, cross: 0, crossLen: 60 },
      { id: "col", axis: "x", pos: 60, cross: 0, crossLen: 100 },
    ]);
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
    // minA 300px in a 1000px container → lo = 0.3
    expect(clampSplit(0.1, 300, 100, 1000)).toBeCloseTo(0.3);
  });

  it("stops at the high bound so panel B keeps its min", () => {
    // minB 300px → hi = 0.7
    expect(clampSplit(0.95, 100, 300, 1000)).toBeCloseTo(0.7);
  });

  it("falls back to the fractional clamp when container size is unknown", () => {
    expect(clampSplit(0.99, 100, 100, 0)).toBe(0.85);
  });

  it("freezes at a stable proportional split when both mins can't fit", () => {
    // 400 + 400 > 500 container → degenerate; proportional split = 0.5, stable
    const f = clampSplit(0.1, 400, 400, 500);
    expect(f).toBeCloseTo(0.5);
    // same result regardless of pointer → no oscillation
    expect(clampSplit(0.9, 400, 400, 500)).toBeCloseTo(f);
  });
});

describe("canFitColumns", () => {
  it("true when the dock is wide enough for both column minimums", () => {
    expect(canFitColumns(700, 300, 300)).toBe(true);
    expect(canFitColumns(600, 300, 300)).toBe(true);
  });

  it("false when the dock is too narrow", () => {
    expect(canFitColumns(500, 300, 300)).toBe(false);
  });
});

describe("DEFAULT_RATIOS", () => {
  it("is a balanced split", () => {
    expect(DEFAULT_RATIOS).toEqual({ v: 0.5, col: 0.5 });
  });
});
