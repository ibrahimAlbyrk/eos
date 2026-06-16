import { describe, it, expect } from "vitest";
import { followAnchorId, selectFollowChildren } from "./followPolicy.js";

// Minimal WorkerRow fixtures — only the fields the policy reads.
const W = (id, extra = {}) => ({ id, state: "IDLE", parent_id: null, is_orchestrator: 0, started_at: 0, ...extra });
const orch = (id, extra = {}) => W(id, { is_orchestrator: 1, ...extra });
const kid = (id, parent, state, started = 0) => W(id, { parent_id: parent, state, started_at: started });

describe("followAnchorId", () => {
  it("an orchestrator selection resolves to itself", () => {
    const ws = [orch("O")];
    expect(followAnchorId(ws, "O")).toBe("O");
  });
  it("a direct child resolves to its orchestrator parent", () => {
    const ws = [orch("O"), kid("a", "O", "WORKING")];
    expect(followAnchorId(ws, "a")).toBe("O");
  });
  it("a grandchild is dormant (null) — shown on its own, not snapped to the grandparent", () => {
    const ws = [orch("O"), kid("a", "O", "IDLE"), kid("g", "a", "WORKING")];
    expect(followAnchorId(ws, "g")).toBe(null);
  });
  it("a child of a non-orchestrator is null", () => {
    const ws = [W("plain"), kid("c", "plain", "WORKING")];
    expect(followAnchorId(ws, "c")).toBe(null);
  });
  it("an orphan / null / missing selection is null", () => {
    expect(followAnchorId([W("lone")], "lone")).toBe(null);
    expect(followAnchorId([orch("O")], null)).toBe(null);
    expect(followAnchorId([orch("O")], "ghost")).toBe(null);
  });
});

describe("selectFollowChildren", () => {
  const CAP = 6;

  it("shows all eligible children under capacity", () => {
    const ws = [orch("O"), kid("a", "O", "WORKING"), kid("b", "O", "IDLE")];
    expect(selectFollowChildren(ws, "O", [], CAP)).toEqual(["a", "b"]);
  });

  it("excludes closed children (DONE/SUSPENDED) and other orchestrators' kids", () => {
    const ws = [
      orch("O"), orch("P"),
      kid("a", "O", "WORKING"), kid("d", "O", "DONE"), kid("s", "O", "SUSPENDED"),
      kid("x", "P", "WORKING"),
    ];
    expect(selectFollowChildren(ws, "O", [], CAP)).toEqual(["a"]);
  });

  it("orders newcomers running-first, then by started_at", () => {
    const ws = [
      orch("O"),
      kid("i", "O", "IDLE", 0),
      kid("r2", "O", "WORKING", 2),
      kid("r1", "O", "WORKING", 1),
    ];
    expect(selectFollowChildren(ws, "O", [], CAP)).toEqual(["r1", "r2", "i"]);
  });

  it("preserves current slots and appends a newcomer", () => {
    const ws = [orch("O"), kid("a", "O", "IDLE"), kid("b", "O", "IDLE"), kid("c", "O", "WORKING")];
    expect(selectFollowChildren(ws, "O", ["a", "b"], CAP)).toEqual(["a", "b", "c"]);
  });

  it("over capacity, running beats idle for the slots", () => {
    const ws = [
      orch("O"),
      kid("r1", "O", "WORKING", 1), kid("r2", "O", "WORKING", 2),
      kid("i1", "O", "IDLE", 0),
    ];
    expect(selectFollowChildren(ws, "O", [], 2)).toEqual(["r1", "r2"]);
  });

  it("a newly-running child evicts an idle one (not a running one), keeping stable slots", () => {
    // two idle children shown, capacity 2; a running newcomer arrives
    const ws = [
      orch("O"),
      kid("i1", "O", "IDLE", 0), kid("i2", "O", "IDLE", 1),
      kid("r", "O", "WORKING", 2),
    ];
    // i1 (earlier slot) kept, i2 evicted, r added → stable order [i1, r]
    expect(selectFollowChildren(ws, "O", ["i1", "i2"], 2)).toEqual(["i1", "r"]);
  });

  it("a pure state flip under capacity is idempotent (same list → reconciler no-ops)", () => {
    const ws = [orch("O"), kid("a", "O", "IDLE"), kid("b", "O", "IDLE")];
    expect(selectFollowChildren(ws, "O", ["a", "b"], CAP)).toEqual(["a", "b"]);
  });

  it("clamps to capacity", () => {
    const ws = [orch("O"), ...Array.from({ length: 9 }, (_, i) => kid("c" + i, "O", "WORKING", i))];
    expect(selectFollowChildren(ws, "O", [], 6)).toHaveLength(6);
  });

  it("drops a child that is no longer eligible from its slot", () => {
    const ws = [orch("O"), kid("a", "O", "WORKING"), kid("b", "O", "DONE")];
    expect(selectFollowChildren(ws, "O", ["a", "b"], CAP)).toEqual(["a"]);
  });

  it("no children → empty; capacity 0 → empty; no orchestrator → empty", () => {
    expect(selectFollowChildren([orch("O")], "O", [], CAP)).toEqual([]);
    expect(selectFollowChildren([orch("O"), kid("a", "O", "WORKING")], "O", [], 0)).toEqual([]);
    expect(selectFollowChildren([], null, [], CAP)).toEqual([]);
  });

  it("pins the viewed child so a background spawn can't evict it", () => {
    // 6 running children fill the cap; an idle 7th is being viewed (pinned)
    const ws = [
      orch("O"),
      ...Array.from({ length: 6 }, (_, i) => kid("r" + i, "O", "WORKING", i)),
      kid("view", "O", "IDLE", 99),
    ];
    const out = selectFollowChildren(ws, "O", [], 6, "view");
    expect(out).toHaveLength(6);
    expect(out).toContain("view");
  });

  it("ignores a pin that is not an eligible child", () => {
    const ws = [orch("O"), kid("a", "O", "WORKING"), kid("d", "O", "DONE")];
    expect(selectFollowChildren(ws, "O", [], CAP, "d")).toEqual(["a"]);
    expect(selectFollowChildren(ws, "O", [], CAP, "ghost")).toEqual(["a"]);
  });
});
