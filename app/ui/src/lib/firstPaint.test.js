import { describe, it, expect, vi } from "vitest";
import { afterFirstPaint, firstPaintDone, holdUntilFirstPaint } from "./firstPaint.js";

describe("afterFirstPaint", () => {
  it("runs at once when start-up holds nothing", async () => {
    const fn = vi.fn(() => 1);
    const result = afterFirstPaint(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await result).toBe(1);
  });

  it("waits for the first paint while start-up holds it, then runs everything held", async () => {
    holdUntilFirstPaint();
    const [a, b] = [vi.fn(() => "a"), vi.fn(async () => "b")];
    const results = Promise.all([afterFirstPaint(a), afterFirstPaint(b)]);
    await Promise.resolve();
    expect(a).not.toHaveBeenCalled();
    firstPaintDone();
    expect(await results).toEqual(["a", "b"]);
    // Later asks run at once.
    const c = vi.fn();
    afterFirstPaint(c);
    expect(c).toHaveBeenCalledTimes(1);
  });
});
