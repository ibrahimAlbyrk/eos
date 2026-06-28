import { describe, it, expect } from "vitest";
import {
  DEFAULT_VIEWPORT,
  screenToFlow,
  flowToScreen,
  snapViewport,
  viewportMatrix,
  createViewport,
  fitViewport,
  visibleFlowRect,
} from "./viewport.js";

describe("viewport — screen↔flow inverse pair", () => {
  it("flowToScreen applies screen = flow * zoom + translate", () => {
    expect(flowToScreen({ x: 50, y: 20, zoom: 2 }, { x: 10, y: 5 })).toEqual({ x: 70, y: 30 });
  });

  it("screenToFlow inverts it (flow = (screen - translate) / zoom)", () => {
    expect(screenToFlow({ x: 50, y: 20, zoom: 2 }, { x: 70, y: 30 })).toEqual({ x: 10, y: 5 });
  });

  it("identity viewport is a pass-through", () => {
    expect(flowToScreen(DEFAULT_VIEWPORT, { x: 12, y: -3 })).toEqual({ x: 12, y: -3 });
    expect(screenToFlow(DEFAULT_VIEWPORT, { x: 12, y: -3 })).toEqual({ x: 12, y: -3 });
  });

  it("screenToFlow∘flowToScreen round-trips at several pan/zoom values", () => {
    const viewports = [
      { x: 0, y: 0, zoom: 1 },
      { x: 120, y: -80, zoom: 0.5 },
      { x: -37.5, y: 210.25, zoom: 1.75 },
      { x: 1000, y: 1000, zoom: 3 },
      { x: -250, y: 64, zoom: 0.1 },
    ];
    const points = [
      { x: 0, y: 0 },
      { x: 184, y: 96 },
      { x: -512, y: 333.5 },
    ];
    for (const vp of viewports) {
      for (const p of points) {
        const back = screenToFlow(vp, flowToScreen(vp, p));
        expect(back.x).toBeCloseTo(p.x, 9);
        expect(back.y).toBeCloseTo(p.y, 9);
      }
    }
  });
});

describe("viewport — integer-snap-at-rest (fractional-translate blur)", () => {
  it("rounds a fractional translate to whole pixels, leaving zoom untouched", () => {
    expect(snapViewport({ x: 12.4, y: -3.6, zoom: 1.5 })).toEqual({ x: 12, y: -4, zoom: 1.5 });
  });

  it("returns the SAME object reference when already integral (loop-free guard)", () => {
    const vp = { x: 10, y: 20, zoom: 2 };
    expect(snapViewport(vp)).toBe(vp);
  });

  it("snaps a non-integral translate to a NEW object", () => {
    const vp = { x: 10.2, y: 20, zoom: 2 };
    expect(snapViewport(vp)).not.toBe(vp);
  });
});

describe("viewport — matrix string", () => {
  it("emits an SVG matrix(zoom,0,0,zoom,x,y)", () => {
    expect(viewportMatrix({ x: 12, y: -4, zoom: 1.5 })).toBe("matrix(1.5,0,0,1.5,12,-4)");
  });
});

describe("viewport — fitViewport frames a bounds box", () => {
  it("centers the bounds and clamps zoom to maxZoom (small content does not over-zoom)", () => {
    // 200x100 content in a 1000x1000 pane, 10% margin each side → fits at zoom 4 but
    // clamps to maxZoom 1; centered on the content midpoint.
    expect(fitViewport({ x: 0, y: 0, w: 200, h: 100 }, { width: 1000, height: 1000 }))
      .toEqual({ x: 400, y: 450, zoom: 1 });
  });

  it("zooms out to fit oversized content (the limiting axis wins)", () => {
    // 2000x1000 content, 1000x1000 pane, 80% usable → min(800/2000, 800/1000)=0.4.
    expect(fitViewport({ x: 0, y: 0, w: 2000, h: 1000 }, { width: 1000, height: 1000 }))
      .toEqual({ x: 100, y: 300, zoom: 0.4 });
  });

  it("clamps to minZoom for enormous content", () => {
    expect(fitViewport({ x: 0, y: 0, w: 100000, h: 100000 }, { width: 100, height: 100 }).zoom).toBe(0.2);
  });

  it("returns DEFAULT_VIEWPORT with no bounds or an unmeasured pane", () => {
    expect(fitViewport(null, { width: 1000, height: 1000 })).toBe(DEFAULT_VIEWPORT);
    expect(fitViewport({ x: 0, y: 0, w: 200, h: 100 }, { width: 0, height: 0 })).toBe(DEFAULT_VIEWPORT);
  });
});

describe("viewport — visibleFlowRect (off-viewport culling source)", () => {
  it("is the whole pane in flow coords at the identity viewport", () => {
    expect(visibleFlowRect(DEFAULT_VIEWPORT, { width: 800, height: 600 }))
      .toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it("inverse-maps the pane corners under pan+zoom", () => {
    expect(visibleFlowRect({ x: 100, y: 50, zoom: 2 }, { width: 800, height: 600 }))
      .toEqual({ x: -50, y: -25, w: 400, h: 300 });
  });
});

describe("viewport — createViewport factory", () => {
  it("binds the helpers to its value and round-trips through them", () => {
    const vp = createViewport({ x: 50, y: 20, zoom: 2 });
    expect(vp.flowToScreen({ x: 10, y: 5 })).toEqual({ x: 70, y: 30 });
    expect(vp.screenToFlow({ x: 70, y: 30 })).toEqual({ x: 10, y: 5 });
    expect(vp.matrix()).toBe("matrix(2,0,0,2,50,20)");
  });

  it("defaults missing fields and snaps to a new bound viewport", () => {
    const vp = createViewport({ zoom: 1.5 });
    expect({ x: vp.x, y: vp.y, zoom: vp.zoom }).toEqual({ x: 0, y: 0, zoom: 1.5 });
    const snapped = createViewport({ x: 3.7, y: 0, zoom: 1 }).snap();
    expect({ x: snapped.x, y: snapped.y, zoom: snapped.zoom }).toEqual({ x: 4, y: 0, zoom: 1 });
  });
});
