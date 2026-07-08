import { describe, it, expect, vi, beforeEach } from "vitest";
import { subscribe, isDockFullscreen, setDockFullscreen, _reset } from "./dockFullscreenStore.js";

beforeEach(() => _reset());

describe("dockFullscreenStore (pane-keyed)", () => {
  it("defaults to false and setDockFullscreen toggles it", () => {
    expect(isDockFullscreen("A")).toBe(false);
    setDockFullscreen("A", true);
    expect(isDockFullscreen("A")).toBe(true);
    setDockFullscreen("A", false);
    expect(isDockFullscreen("A")).toBe(false);
  });

  it("subscribe is pane-scoped: pane A's toggle never notifies pane B", () => {
    const aCalls = vi.fn();
    const bCalls = vi.fn();
    subscribe("A", aCalls);
    subscribe("B", bCalls);

    setDockFullscreen("A", true);
    expect(aCalls).toHaveBeenCalledTimes(1);
    expect(bCalls).not.toHaveBeenCalled();
    expect(isDockFullscreen("B")).toBe(false); // per-pane independence
  });

  it("setDockFullscreen is a no-op (no emit) when the value is unchanged", () => {
    const calls = vi.fn();
    subscribe("A", calls);
    setDockFullscreen("A", false); // already false
    expect(calls).not.toHaveBeenCalled();
    setDockFullscreen("A", true);
    setDockFullscreen("A", true); // already true
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops notifications", () => {
    const calls = vi.fn();
    const unsub = subscribe("A", calls);
    unsub();
    setDockFullscreen("A", true);
    expect(calls).not.toHaveBeenCalled();
  });

  it("_reset clears every pane's flag", () => {
    setDockFullscreen("A", true);
    setDockFullscreen("B", true);
    _reset();
    expect(isDockFullscreen("A")).toBe(false);
    expect(isDockFullscreen("B")).toBe(false);
  });
});
