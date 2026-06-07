import { describe, it, expect } from "vitest";
import { deriveActivity } from "./agentActivity.js";

const NOW = 1_000_000;

describe("deriveActivity", () => {
  it("busy + elapsed while WORKING with a turn clock", () => {
    const a = deriveActivity({ state: "WORKING", turn_started_at: NOW - 5000 }, NOW);
    expect(a).toEqual({ busy: true, elapsedMs: 5000 });
  });

  it("busy + elapsed while SPAWNING (boot counts as the turn)", () => {
    const a = deriveActivity({ state: "SPAWNING", turn_started_at: NOW - 1500 }, NOW);
    expect(a).toEqual({ busy: true, elapsedMs: 1500 });
  });

  it("no elapsed when idle, even with a stale stamp", () => {
    const a = deriveActivity({ state: "IDLE", turn_started_at: NOW - 5000 }, NOW);
    expect(a).toEqual({ busy: false, elapsedMs: null });
  });

  it("no elapsed when busy but stamp missing (pre-migration rows)", () => {
    const a = deriveActivity({ state: "WORKING", turn_started_at: null }, NOW);
    expect(a).toEqual({ busy: true, elapsedMs: null });
  });

  it("clamps clock skew to 0", () => {
    const a = deriveActivity({ state: "WORKING", turn_started_at: NOW + 999 }, NOW);
    expect(a.elapsedMs).toBe(0);
  });

  it("handles missing worker", () => {
    expect(deriveActivity(null, NOW)).toEqual({ busy: false, elapsedMs: null });
  });
});
