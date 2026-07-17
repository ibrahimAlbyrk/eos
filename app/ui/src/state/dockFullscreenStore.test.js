import { describe, it, expect, vi, beforeEach } from "vitest";
import { subscribe, isDockFullscreen, fullscreenType, setDockFullscreen, _reset } from "./dockFullscreenStore.js";

beforeEach(() => _reset());

describe("dockFullscreenStore (pane-keyed)", () => {
  it("defaults to no maximized panel", () => {
    expect(isDockFullscreen("A")).toBe(false);
    expect(fullscreenType("A")).toBeNull();
  });

  it("maximizes ONE panel by type — that type alone is the target", () => {
    // Two panels open (file over gitdiff); maximizing file records file, so the
    // dock shows only file and hides gitdiff — not both widened.
    setDockFullscreen("A", "file");
    expect(isDockFullscreen("A")).toBe(true);
    expect(fullscreenType("A")).toBe("file");
  });

  it("re-targets the maximize when a different panel's button is pressed", () => {
    setDockFullscreen("A", "file");
    setDockFullscreen("A", "gitdiff");
    expect(fullscreenType("A")).toBe("gitdiff");
  });

  it("clears with false, restoring the un-maximized state", () => {
    setDockFullscreen("A", "file");
    setDockFullscreen("A", false);
    expect(isDockFullscreen("A")).toBe(false);
    expect(fullscreenType("A")).toBeNull();
  });

  it("treats a non-string (legacy boolean) as clear, never a phantom fullscreen", () => {
    setDockFullscreen("A", true);
    expect(isDockFullscreen("A")).toBe(false);
    expect(fullscreenType("A")).toBeNull();
  });

  it("subscribe is pane-scoped: pane A's toggle never notifies pane B", () => {
    const aCalls = vi.fn();
    const bCalls = vi.fn();
    subscribe("A", aCalls);
    subscribe("B", bCalls);

    setDockFullscreen("A", "file");
    expect(aCalls).toHaveBeenCalledTimes(1);
    expect(bCalls).not.toHaveBeenCalled();
    expect(fullscreenType("B")).toBeNull(); // per-pane independence
  });

  it("setDockFullscreen is a no-op (no emit) when the target is unchanged", () => {
    const calls = vi.fn();
    subscribe("A", calls);
    setDockFullscreen("A", false); // already cleared
    expect(calls).not.toHaveBeenCalled();
    setDockFullscreen("A", "file");
    setDockFullscreen("A", "file"); // same target
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops notifications", () => {
    const calls = vi.fn();
    const unsub = subscribe("A", calls);
    unsub();
    setDockFullscreen("A", "file");
    expect(calls).not.toHaveBeenCalled();
  });

  it("_reset clears every pane's target", () => {
    setDockFullscreen("A", "file");
    setDockFullscreen("B", "gitdiff");
    _reset();
    expect(fullscreenType("A")).toBeNull();
    expect(fullscreenType("B")).toBeNull();
  });
});
