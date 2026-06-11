import { describe, it, expect } from "vitest";
import { fmtTimeAgo, statusFromState } from "./format.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("fmtTimeAgo", () => {
  const now = 1_700_000_000_000;

  it("returns just now under a minute", () => {
    expect(fmtTimeAgo(now, now)).toBe("just now");
    expect(fmtTimeAgo(now - 59_000, now)).toBe("just now");
  });

  it("formats minutes", () => {
    expect(fmtTimeAgo(now - MIN, now)).toBe("1m ago");
    expect(fmtTimeAgo(now - 59 * MIN, now)).toBe("59m ago");
  });

  it("formats hours", () => {
    expect(fmtTimeAgo(now - HOUR, now)).toBe("1h ago");
    expect(fmtTimeAgo(now - 23 * HOUR, now)).toBe("23h ago");
  });

  it("formats days then weeks", () => {
    expect(fmtTimeAgo(now - DAY, now)).toBe("1d ago");
    expect(fmtTimeAgo(now - 6 * DAY, now)).toBe("6d ago");
    expect(fmtTimeAgo(now - 7 * DAY, now)).toBe("1w ago");
    expect(fmtTimeAgo(now - 29 * DAY, now)).toBe("4w ago");
  });

  it("formats months then years", () => {
    expect(fmtTimeAgo(now - 30 * DAY, now)).toBe("1mo ago");
    expect(fmtTimeAgo(now - 364 * DAY, now)).toBe("12mo ago");
    expect(fmtTimeAgo(now - 365 * DAY, now)).toBe("1y ago");
  });

  it("treats future ts as just now", () => {
    expect(fmtTimeAgo(now + 5000, now)).toBe("just now");
  });
});

describe("statusFromState", () => {
  it("presents SUSPENDED as idle", () => {
    expect(statusFromState("SUSPENDED")).toEqual({ dot: "wait", label: "idle" });
  });

  it("presents SPAWNING as running and DRAFT as idle", () => {
    expect(statusFromState("SPAWNING")).toEqual({ dot: "run", label: "running" });
    expect(statusFromState("DRAFT")).toEqual({ dot: "wait", label: "idle" });
  });

  it("falls back to lowercased state", () => {
    expect(statusFromState("KILLING")).toEqual({ dot: "queue", label: "killing" });
    expect(statusFromState(undefined)).toEqual({ dot: "wait", label: "idle" });
  });
});
