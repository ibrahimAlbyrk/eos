import { describe, it, expect, vi, afterEach } from "vitest";
import { ROUTES } from "../../api/routes.js";
import {
  beginStroke, extendStroke, makeText, undoStrokes, clearStrokes,
  exportScale, drawStrokes, paintComposite, uploadAnnotation, TEXT_SIZE,
} from "./annotationExport.js";

// A stand-in 2D context that records every draw call and holds the mutable
// style props drawStroke reads back (lineWidth for the dot radius). Enough to
// assert geometry without a real canvas (the vitest env has no DOM).
function recordingCtx() {
  const calls = [];
  const ctx = {
    calls,
    strokeStyle: null, fillStyle: null, lineWidth: 0, lineCap: null, lineJoin: null,
    font: null, textBaseline: null,
  };
  for (const op of ["save", "restore", "beginPath", "moveTo", "lineTo", "stroke", "fill",
    "arc", "ellipse", "strokeRect", "fillText", "drawImage", "setTransform", "clearRect"]) {
    ctx[op] = (...args) => calls.push({ op, args, lineWidth: ctx.lineWidth, font: ctx.font });
  }
  return ctx;
}
const ops = (ctx, op) => ctx.calls.filter((c) => c.op === op);

describe("stroke model", () => {
  it("pen accumulates points; shapes carry a start→end box", () => {
    const pen = extendStroke(beginStroke("pen", "#f00", { x: 1, y: 2 }), { x: 3, y: 4 });
    expect(pen).toMatchObject({ tool: "pen", color: "#f00", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });

    const rect = extendStroke(beginStroke("rect", "#0f0", { x: 5, y: 6 }), { x: 9, y: 12 });
    expect(rect).toMatchObject({ tool: "rect", x0: 5, y0: 6, x1: 9, y1: 12 });
  });

  it("makeText carries the point, string, selected colour, and font size", () => {
    expect(makeText("#00f", { x: 4, y: 7 }, "hi")).toMatchObject({
      tool: "text", x: 4, y: 7, text: "hi", color: "#00f", fontSize: TEXT_SIZE,
    });
  });

  it("undo drops the last stroke; clear empties", () => {
    expect(undoStrokes(["a", "b", "c"])).toEqual(["a", "b"]);
    expect(undoStrokes([])).toEqual([]);
    expect(clearStrokes()).toEqual([]);
  });

  it("undo removes a text stroke like any other tool", () => {
    const pen = beginStroke("pen", "#f00", { x: 0, y: 0 });
    const text = makeText("#00f", { x: 1, y: 2 }, "note");
    expect(undoStrokes([pen, text])).toEqual([pen]);
    expect(clearStrokes()).toEqual([]);
  });
});

describe("exportScale", () => {
  it("is the per-axis ratio from display px to target px", () => {
    expect(exportScale({ width: 640, height: 400 }, { width: 1280, height: 800 })).toEqual({ sx: 2, sy: 2 });
  });
  it("guards a zero display size", () => {
    expect(exportScale({ width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({ sx: 1, sy: 1 });
  });
});

describe("drawStrokes geometry (scaled)", () => {
  const S = 2; // sx = sy = 2

  it("pen with one point draws a filled dot; multi-point strokes a path", () => {
    const dot = recordingCtx();
    drawStrokes(dot, [beginStroke("pen", "#f00", { x: 10, y: 20 })], S, S);
    expect(ops(dot, "arc")[0].args.slice(0, 2)).toEqual([20, 40]);
    expect(ops(dot, "fill").length).toBe(1);

    const path = recordingCtx();
    drawStrokes(path, [{ tool: "pen", color: "#f00", width: 3, points: [{ x: 1, y: 1 }, { x: 2, y: 3 }] }], S, S);
    expect(ops(path, "moveTo")[0].args).toEqual([2, 2]);
    expect(ops(path, "lineTo")[0].args).toEqual([4, 6]);
    expect(ops(path, "stroke").length).toBe(1);
  });

  it("line maps both endpoints", () => {
    const ctx = recordingCtx();
    drawStrokes(ctx, [{ tool: "line", color: "#f00", x0: 1, y0: 2, x1: 3, y1: 4 }], S, S);
    expect(ops(ctx, "moveTo")[0].args).toEqual([2, 4]);
    expect(ops(ctx, "lineTo")[0].args).toEqual([6, 8]);
  });

  it("rect normalizes to top-left + size", () => {
    const ctx = recordingCtx();
    drawStrokes(ctx, [{ tool: "rect", color: "#f00", x0: 30, y0: 40, x1: 10, y1: 15 }], S, S);
    // min corner (10,15) → *2 = (20,30); size (20,25) → *2 = (40,50)
    expect(ops(ctx, "strokeRect")[0].args).toEqual([20, 30, 40, 50]);
  });

  it("ellipse maps centre + radii", () => {
    const ctx = recordingCtx();
    drawStrokes(ctx, [{ tool: "ellipse", color: "#f00", x0: 0, y0: 0, x1: 20, y1: 40 }], S, S);
    const [cx, cy, rx, ry] = ops(ctx, "ellipse")[0].args;
    expect([cx, cy, rx, ry]).toEqual([20, 40, 20, 40]); // centre (10,20)*2, radii (10,20)*2
  });

  it("text draws at the scaled point and scaled font size", () => {
    const ctx = recordingCtx();
    drawStrokes(ctx, [makeText("#f00", { x: 5, y: 6 }, "hi")], S, S);
    const ft = ops(ctx, "fillText")[0];
    expect(ft.args).toEqual(["hi", 10, 12]);          // point (5,6) * 2
    expect(ft.font).toContain(`${TEXT_SIZE * S}px`);  // font size scaled by sy, not left at display px
  });
});

describe("paintComposite", () => {
  it("draws the base at target size, then strokes scaled from display to target", () => {
    const ctx = recordingCtx();
    const base = { BASE: true };
    paintComposite(ctx, base, { width: 1280, height: 800 }, [
      { tool: "rect", color: "#f00", x0: 0, y0: 0, x1: 100, y1: 50 },
    ], { width: 640, height: 400 });

    expect(ops(ctx, "drawImage")[0].args).toEqual([base, 0, 0, 1280, 800]);
    // display 640→target 1280 ⇒ sx=2; rect size (100,50)*2 = (200,100)
    expect(ops(ctx, "strokeRect")[0].args).toEqual([0, 0, 200, 100]);
  });

  it("composites a text stroke at the scaled position and font size", () => {
    const ctx = recordingCtx();
    paintComposite(ctx, { BASE: true }, { width: 1280, height: 800 },
      [makeText("#f00", { x: 5, y: 6 }, "hi")], { width: 640, height: 400 });
    const ft = ops(ctx, "fillText")[0];
    expect(ft.args).toEqual(["hi", 10, 12]);          // display 640→target 1280 ⇒ ×2
    expect(ft.font).toContain(`${TEXT_SIZE * 2}px`);  // font size scales with the frame, not tiny
  });
});

describe("uploadAnnotation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the composited bytes to /fs/paste as octet-stream with x-filename", async () => {
    const seen = {};
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      seen.url = url;
      seen.opts = opts;
      seen.bytes = new Uint8Array(opts.body);
      return { ok: true, status: 200, json: async () => ({ path: "/tmp/eos/annotation.png" }) };
    }));

    const blob = new Blob([new Uint8Array([7, 8, 9])], { type: "image/png" });
    const path = await uploadAnnotation(blob, "annotation-42.png");

    expect(path).toBe("/tmp/eos/annotation.png");
    expect(new URL(seen.url).pathname).toBe(ROUTES.fsPaste);
    expect(seen.opts.method).toBe("POST");
    expect(seen.opts.headers["content-type"]).toBe("application/octet-stream");
    expect(seen.opts.headers["x-filename"]).toBe("annotation-42.png");
    expect([...seen.bytes]).toEqual([7, 8, 9]);
  });

  it("throws when the upload is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 413, json: async () => ({}) })));
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    await expect(uploadAnnotation(blob, "x.png")).rejects.toThrow(/413/);
  });
});
