import { describe, it, expect, vi } from "vitest";
import { preloadable } from "./preloadable.js";

describe("preloadable", () => {
  it("loads once and keeps the module", async () => {
    const load = vi.fn().mockResolvedValue({ x: 1 });
    const p = preloadable(load);
    expect(p.value).toBeNull();
    await Promise.all([p.load(), p.load()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(p.value).toEqual({ x: 1 });
  });

  // SettingsModal and TerminalView rely on this: a failed chunk is tried again on
  // the next open / mount instead of failing forever.
  it("forgets a failed load, so the next load tries again", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("chunk")).mockResolvedValueOnce({ x: 2 });
    const p = preloadable(load);
    await expect(p.load()).rejects.toThrow("chunk");
    expect(p.value).toBeNull();
    await expect(p.load()).resolves.toEqual({ x: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
