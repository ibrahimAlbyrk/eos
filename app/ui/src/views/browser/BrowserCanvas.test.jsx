import { describe, it, expect } from "vitest";
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
});
