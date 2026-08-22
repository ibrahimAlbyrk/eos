import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnnotationLayer, COLORS, hasPaintedFrame } from "./AnnotationLayer.jsx";
import { beginStroke } from "./annotationExport.js";

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

describe("pencil colour palette", () => {
  it("offers at least 9 distinct colours including black and white", () => {
    expect(COLORS.length).toBeGreaterThanOrEqual(9);
    expect(COLORS).toContain("#000000");
    expect(COLORS).toContain("#ffffff");
    expect(new Set(COLORS).size).toBe(COLORS.length); // no duplicates
    for (const c of COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/); // all valid hex
  });

  it("renders one swatch per palette colour and marks the active colour selected", () => {
    const html = renderToStaticMarkup(<AnnotationLayer paneId="A" tabId="t1" />);
    // every colour has a swatch button carrying it as the --swatch custom prop
    for (const c of COLORS) expect(html).toContain(`--swatch:${c}`);
    expect((html.match(/--swatch:/g) ?? []).length).toBe(COLORS.length);
    // the default colour (index 0, black) is the selected swatch; white is not
    expect(html).toMatch(new RegExp(`annotation-swatch on"[^>]*--swatch:${COLORS[0]}[^>]*aria-pressed="true"`));
    expect(html).toMatch(/--swatch:#ffffff[^>]*aria-pressed="false"/);
  });

  it("selecting a swatch is what colours the stroke (colour state feeds beginStroke)", () => {
    // The swatch onClick sets the colour state; a stroke started with that colour
    // carries it verbatim, so picking a swatch changes the drawn colour.
    for (const c of ["#000000", "#ffffff", "#007aff"]) {
      expect(beginStroke("pen", c, { x: 1, y: 1 }).color).toBe(c);
    }
  });
});

describe("text tool", () => {
  it("offers a Text tool button in the toolbar so the tool is selectable", () => {
    const html = renderToStaticMarkup(<AnnotationLayer paneId="A" tabId="t1" />);
    expect(html).toContain('aria-label="Text"');
    expect(html).toContain('title="Text"');
  });

  it("no text input is shown until a point is placed (textEdit starts null)", () => {
    const html = renderToStaticMarkup(<AnnotationLayer paneId="A" tabId="t1" />);
    expect(html).not.toContain("annotation-text-input");
  });
});
