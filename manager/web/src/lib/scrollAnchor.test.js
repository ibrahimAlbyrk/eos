import { describe, it, expect } from "vitest";
import { captureAnchor, resolveAnchorTop } from "./scrollAnchor.js";

// Stubs mimic just the DOM surface the lib touches — no jsdom needed.
function blockEl(key, top, height = 100) {
  return {
    dataset: { bkey: key },
    getBoundingClientRect: () => ({ top, bottom: top + height }),
  };
}
function content(...els) {
  return { querySelectorAll: () => els };
}
function scroller(viewTop, scrollTop = 0) {
  return { getBoundingClientRect: () => ({ top: viewTop }), scrollTop };
}

describe("captureAnchor", () => {
  it("picks the first block crossing the viewport top, with its offset", () => {
    const c = content(blockEl("a", -300), blockEl("b", -40), blockEl("c", 60));
    expect(captureAnchor(scroller(0), c)).toEqual({ key: "b", offset: -40 });
  });

  it("offset is relative to the scroller's client top, not the page", () => {
    const c = content(blockEl("a", 80));
    expect(captureAnchor(scroller(100), c)).toEqual({ key: "a", offset: -20 });
  });

  it("returns null with no blocks or when all blocks end above the viewport", () => {
    expect(captureAnchor(scroller(0), content())).toBe(null);
    expect(captureAnchor(scroller(500), content(blockEl("a", 0)))).toBe(null);
    expect(captureAnchor(null, content(blockEl("a", 0)))).toBe(null);
    expect(captureAnchor(scroller(0), null)).toBe(null);
  });
});

describe("resolveAnchorTop", () => {
  it("returns the scrollTop that restores the captured offset", () => {
    // Block currently 600px below the viewport top while scrollTop is 0;
    // captured offset was -40 → need to scroll 640px down.
    const c = content(blockEl("x", 700));
    expect(resolveAnchorTop(scroller(100, 0), c, { key: "x", offset: -40 })).toBe(640);
  });

  it("accounts for the scroller's current scrollTop", () => {
    const c = content(blockEl("x", 100));
    expect(resolveAnchorTop(scroller(100, 250), c, { key: "x", offset: 0 })).toBe(250);
  });

  it("returns null when the anchor block is not rendered", () => {
    const c = content(blockEl("y", 0));
    expect(resolveAnchorTop(scroller(0), c, { key: "x", offset: 0 })).toBe(null);
  });
});

describe("round-trip", () => {
  it("capture → resolve reproduces the original scrollTop", () => {
    const viewTop = 50;
    const scrollTopAtCapture = 730;
    // Block sits at content offset 700; with scrollTop 730 its client top is
    // viewTop + (700 - 730) = 20.
    const captured = captureAnchor(scroller(viewTop, scrollTopAtCapture), content(blockEl("k", 20)));
    expect(captured).toEqual({ key: "k", offset: -30 });
    // Fresh window: same block now at client top viewTop + 700 (scrollTop 0).
    const top = resolveAnchorTop(scroller(viewTop, 0), content(blockEl("k", 750)), captured);
    expect(top).toBe(scrollTopAtCapture);
  });
});
