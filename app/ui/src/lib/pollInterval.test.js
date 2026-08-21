import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { startPolling } from "./pollInterval.js";

function fakeDocument() {
  const listeners = new Set();
  return {
    hidden: false,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    emitVisibilityChange: () => { for (const fn of listeners) fn(); },
    listenerCount: () => listeners.size,
  };
}

describe("startPolling", () => {
  let doc;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = fakeDocument();
    globalThis.document = doc;
  });
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.document;
  });

  it("ticks on the interval while visible", () => {
    const fn = vi.fn();
    const stop = startPolling(fn, 1000);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });

  it("skips ticks while hidden and catches up on re-show", () => {
    const fn = vi.fn();
    const stop = startPolling(fn, 1000);
    doc.hidden = true;
    vi.advanceTimersByTime(3000);
    expect(fn).not.toHaveBeenCalled();
    doc.hidden = false;
    doc.emitVisibilityChange();
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("drops the timer and the listener on cleanup", () => {
    const fn = vi.fn();
    startPolling(fn, 1000)();
    vi.advanceTimersByTime(3000);
    doc.emitVisibilityChange();
    expect(fn).not.toHaveBeenCalled();
    expect(doc.listenerCount()).toBe(0);
  });

  it("falls back to a plain interval with no document", () => {
    delete globalThis.document;
    const fn = vi.fn();
    const stop = startPolling(fn, 1000);
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);
    stop();
  });
});
