import { describe, it, expect } from "vitest";
import { shouldStick, shouldAutoScroll } from "./scrollStick.js";

describe("shouldStick", () => {
  it("is true when exactly at bottom (dist 0)", () => {
    expect(shouldStick({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(true);
  });

  it("is true within threshold including a 2px sub-pixel overshoot", () => {
    expect(shouldStick({ scrollHeight: 1002, scrollTop: 800, clientHeight: 200 })).toBe(true);
  });

  it("is true at dist 39 and false at dist 40 (strict < default threshold)", () => {
    expect(shouldStick({ scrollHeight: 1039, scrollTop: 800, clientHeight: 200 })).toBe(true);
    expect(shouldStick({ scrollHeight: 1040, scrollTop: 800, clientHeight: 200 })).toBe(false);
  });

  it("is false at dist 120", () => {
    expect(shouldStick({ scrollHeight: 1120, scrollTop: 800, clientHeight: 200 })).toBe(false);
  });

  it("honors a custom threshold argument", () => {
    expect(shouldStick({ scrollHeight: 1020, scrollTop: 800, clientHeight: 200 }, 10)).toBe(false);
    expect(shouldStick({ scrollHeight: 1005, scrollTop: 800, clientHeight: 200 }, 10)).toBe(true);
  });
});

describe("shouldAutoScroll", () => {
  it("is false when isProgrammatic, regardless of other inputs", () => {
    expect(shouldAutoScroll(true, true, 10_000)).toBe(false);
  });

  it("is false when msSinceUserScroll <= idleMs even if near-bottom and not programmatic", () => {
    expect(shouldAutoScroll(true, false, 100)).toBe(false);
    expect(shouldAutoScroll(true, false, 150)).toBe(false);
  });

  it("is false when not near-bottom even if not programmatic and user idle", () => {
    expect(shouldAutoScroll(false, false, 300)).toBe(false);
  });

  it("is true only when near-bottom AND not programmatic AND user idle", () => {
    expect(shouldAutoScroll(true, false, 300)).toBe(true);
  });
});
