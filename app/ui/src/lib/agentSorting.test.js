import { describe, it, expect } from "vitest";
import { sortRoots } from "./agentSorting.js";

const w = (id, extra = {}) => ({ id, name: null, is_orchestrator: false, started_at: 0, ...extra });

describe("sortRoots", () => {
  it("alpha sorts by display name, case-insensitive", () => {
    const out = sortRoots([w("1", { name: "banana" }), w("2", { name: "Apple" }), w("3", { name: "cherry" })], "alpha");
    expect(out.map((x) => x.name)).toEqual(["Apple", "banana", "cherry"]);
  });

  it("created sorts by started_at ascending", () => {
    const out = sortRoots([w("a", { started_at: 300 }), w("b", { started_at: 100 }), w("c", { started_at: 200 })], "created");
    expect(out.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("recency sorts by turn_started_at desc, falling back to started_at", () => {
    const out = sortRoots([
      w("stale", { started_at: 100, turn_started_at: 150 }),
      w("fresh", { started_at: 50, turn_started_at: 900 }),
      w("never", { started_at: 200 }),
    ], "recency");
    expect(out.map((x) => x.id)).toEqual(["fresh", "never", "stale"]);
  });

  it("breaks ties by id for a deterministic total order", () => {
    const out = sortRoots([w("z", { started_at: 5 }), w("a", { started_at: 5 })], "created");
    expect(out.map((x) => x.id)).toEqual(["a", "z"]);
  });

  it("does not mutate the input array", () => {
    const input = [w("b", { started_at: 2 }), w("a", { started_at: 1 })];
    const copy = input.slice();
    sortRoots(input, "created");
    expect(input).toEqual(copy);
  });

  it("falls back to recency for an unknown mode", () => {
    const out = sortRoots([w("a", { turn_started_at: 1 }), w("b", { turn_started_at: 2 })], "bogus");
    expect(out.map((x) => x.id)).toEqual(["b", "a"]);
  });
});
