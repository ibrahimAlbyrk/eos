import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserCanvas } from "./BrowserCanvas.jsx";

// The letterbox fix: in Responsive the canvas FILLS the panel (the daemon now
// emulates the panel's own size, so the frame aspect matches) — no fixed aspect
// ratio is pinned. Mobile/Tablet keep the viewport aspect and letterbox inside
// the DeviceFrame. ws is null so the paint effect is inert under SSR.
describe("BrowserCanvas fill vs letterbox", () => {
  const viewport = { width: 1600, height: 900 };

  it("Responsive (fill) fills with no fixed aspect ratio", () => {
    const html = renderToStaticMarkup(<BrowserCanvas ws={null} viewport={viewport} fill />);
    expect(html).toContain("browser-canvas is-fill");
    expect(html).not.toContain("aspect-ratio");
  });

  it("Mobile/Tablet (non-fill) keeps the viewport aspect ratio", () => {
    const html = renderToStaticMarkup(<BrowserCanvas ws={null} viewport={viewport} fill={false} />);
    expect(html).toContain('class="browser-canvas"');
    expect(html).toContain("aspect-ratio:1600 / 900");
  });

  // The squished-page regression: the backing store is per-frame, the CSS box
  // is per-panel/device — when their aspects diverge (mid resize/device switch,
  // or a stale frame after a stream hiccup) a bare canvas SCALES TO FILL and
  // distorts. object-fit: contain pins letterbox-never-stretch.
  it("never stretches a mismatched frame: .browser-canvas pins object-fit: contain", () => {
    const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    const rule = css.match(/\.browser-canvas\s*\{[^}]*\}/s)?.[0];
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/object-fit:\s*contain/);
  });
});
