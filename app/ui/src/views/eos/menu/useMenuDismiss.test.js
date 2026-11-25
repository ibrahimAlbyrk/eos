import { describe, expect, it, vi } from "vitest";
import { watchDismiss } from "./useMenuDismiss.js";

function fakeDoc() {
  const on = new Map();
  return {
    addEventListener: (type, fn) => on.set(type, fn),
    removeEventListener: (type, fn) => { if (on.get(type) === fn) on.delete(type); },
    fire: (type, e) => on.get(type)?.(e),
    count: () => on.size,
  };
}

describe("an open menu", () => {
  const inside = {};
  const wrapper = { contains: (t) => t === inside };

  it("closes on a press outside it or on Escape, and not on a press inside or another key", () => {
    const doc = fakeDoc();
    const close = vi.fn();
    watchDismiss(doc, () => wrapper, close);
    doc.fire("mousedown", { target: inside });
    doc.fire("keydown", { key: "ArrowDown" });
    expect(close).not.toHaveBeenCalled();
    doc.fire("mousedown", { target: {} });
    doc.fire("keydown", { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("stops listening once it is closed", () => {
    const doc = fakeDoc();
    const stop = watchDismiss(doc, () => wrapper, () => {});
    expect(doc.count()).toBe(2);
    stop();
    expect(doc.count()).toBe(0);
  });
});
