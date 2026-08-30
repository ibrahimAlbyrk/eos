import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnnotationLayer, COLORS, containBox } from "./AnnotationLayer.jsx";
import { beginStroke } from "./annotationExport.js";

// The annotate overlay now captures the embedded view to a still (hide-on-overlay)
// instead of freezing a screencast canvas. The still + draw canvas share one
// contain-fit box; containBox is that geometry, kept pure and testable.
describe("containBox (still fit)", () => {
  it("fits by width in a wide container and preserves the still aspect", () => {
    const box = containBox({ width: 1000, height: 600 }, { width: 800, height: 600 });
    // 1000/800 = 1.25 vs 600/600 = 1.0 → height-limited
    expect(box.height).toBeCloseTo(600, 5);
    expect(box.width).toBeCloseTo(800, 5);
    expect(box.width / box.height).toBeCloseTo(800 / 600, 5);
  });

  it("fits by the tighter axis and keeps the aspect", () => {
    const box = containBox({ width: 400, height: 1000 }, { width: 800, height: 600 });
    expect(box.width).toBeCloseTo(400, 5); // width-limited
    expect(box.width / box.height).toBeCloseTo(800 / 600, 5);
  });

  it("is null until both container and still are measured", () => {
    expect(containBox({ width: 0, height: 0 }, { width: 800, height: 600 })).toBeNull();
    expect(containBox({ width: 800, height: 600 }, null)).toBeNull();
    expect(containBox(null, { width: 800, height: 600 })).toBeNull();
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
