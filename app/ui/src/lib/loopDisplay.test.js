import { describe, it, expect } from "vitest";
import { loopStatusLabel, loopAttemptText, loopSummary, loopBadgeTitle, spawnLoopDetails } from "./loopDisplay.js";

describe("loopDisplay", () => {
  it("formats bounded and unbounded attempt counts", () => {
    expect(loopAttemptText({ attempt: 2, maxAttempts: 5 })).toBe("2/5");
    expect(loopAttemptText({ attempt: 3, maxAttempts: null })).toBe("3");
  });

  it("summarizes status + attempt", () => {
    expect(loopSummary({ status: "active", attempt: 1, maxAttempts: 4 })).toBe("active · attempt 1/4");
  });

  it("appends lastReason to the badge tooltip when present", () => {
    expect(loopBadgeTitle({ status: "active", attempt: 1, maxAttempts: 4, lastReason: "unmet: c1" }))
      .toBe("Loop: active · attempt 1/4 — unmet: c1");
    expect(loopBadgeTitle({ status: "passed", attempt: 2, maxAttempts: 2, lastReason: null }))
      .toBe("Loop: passed · attempt 2/2");
  });

  it("returns empty strings for a missing loop", () => {
    expect(loopSummary(null)).toBe("");
    expect(loopBadgeTitle(undefined)).toBe("");
    expect(loopAttemptText(null)).toBe("");
  });

  it("falls back to the raw status when unknown", () => {
    expect(loopStatusLabel({ status: "weird" })).toBe("weird");
  });

  it("formats arm-at-spawn loop details with bounded/unbounded limit", () => {
    expect(spawnLoopDetails({ goal: { summary: "tests green" }, strategy: "command", limit: 5 }))
      .toBe("Loop: tests green · command · limit 5");
    expect(spawnLoopDetails({ goal: { summary: "tests green" } }))
      .toBe("Loop: tests green · hybrid · unbounded");
    expect(spawnLoopDetails({ goal: { summary: "x" }, strategy: "judge", limit: null }))
      .toBe("Loop: x · judge · unbounded");
    expect(spawnLoopDetails(null)).toBe("");
  });
});
