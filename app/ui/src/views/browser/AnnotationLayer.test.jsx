import { describe, it, expect } from "vitest";
import { hasPaintedFrame } from "./AnnotationLayer.jsx";

// The annotate overlay freezes the live .browser-canvas the instant pencil mode
// starts. The guard below is what stops it committing a blank freeze — the bug
// that left a white band across the top of the panel on reopen, when the overlay
// remounted over a canvas that had not painted its first frame yet.
const canvas = (width, height, alpha) => ({
  width,
  height,
  getContext: () => ({
    // one centre pixel; a streamed JPEG frame is opaque, a fresh canvas transparent
    getImageData: () => ({ data: new Uint8ClampedArray([12, 34, 56, alpha]) }),
  }),
});

describe("hasPaintedFrame (freeze guard)", () => {
  it("is false for a fresh canvas: default backing store, fully transparent", () => {
    // A just-mounted <canvas> keeps the 300x150 default (so a size-only check
    // would wrongly pass), yet every pixel is transparent — nothing to freeze.
    expect(hasPaintedFrame(canvas(300, 150, 0))).toBe(false);
  });

  it("is false for a zero-sized canvas", () => {
    expect(hasPaintedFrame(canvas(0, 0, 255))).toBe(false);
    expect(hasPaintedFrame(canvas(1200, 0, 255))).toBe(false);
  });

  it("is true once a real, opaque frame has been painted", () => {
    expect(hasPaintedFrame(canvas(1200, 800, 255))).toBe(true);
  });

  it("is false when the pixels cannot be read (missing/tainted canvas)", () => {
    expect(hasPaintedFrame(null)).toBe(false);
    expect(hasPaintedFrame({ width: 1200, height: 800, getContext: () => { throw new Error("tainted"); } })).toBe(false);
  });
});
