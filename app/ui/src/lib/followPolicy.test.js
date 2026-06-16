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

  it("a running newcomer recycles the last idle slot in place (no new pane)", () => {
    const ws = [orch("O"), kid("a", "O", "IDLE"), kid("b", "O", "IDLE"), kid("c", "O", "WORKING")];
    // c takes b's slot (the last idle); a (earlier slot) stays put → no 3rd pane.
    expect(selectFollowChildren(ws, "O", ["a", "b"], CAP)).toEqual(["a", "c"]);
  });

  it("recycles from the end across many idle slots — earlier panes stay put", () => {
    const ws = [
      orch("O"),
      kid("a", "O", "IDLE"), kid("b", "O", "IDLE"), kid("c", "O", "IDLE"),
      kid("n", "O", "WORKING", 9),
    ];
    expect(selectFollowChildren(ws, "O", ["a", "b", "c"], CAP)).toEqual(["a", "b", "n"]);
  });

  it("does not recycle a working slot — only idle slots are recycled", () => {
    const ws = [orch("O"), kid("a", "O", "WORKING"), kid("c", "O", "WORKING", 5)];
    expect(selectFollowChildren(ws, "O", ["a"], CAP)).toEqual(["a", "c"]);
  });

  it("an idle newcomer does not recycle a shown idle slot — it appends", () => {
    const ws = [orch("O"), kid("a", "O", "IDLE"), kid("n", "O", "IDLE", 5)];
    expect(selectFollowChildren(ws, "O", ["a"], CAP)).toEqual(["a", "n"]);
  });

  it("never recycles the pinned (viewed) idle slot — a background idle slot is taken instead", () => {
    const ws = [orch("O"), kid("a", "O", "IDLE"), kid("b", "O", "IDLE"), kid("c", "O", "WORKING")];
    // viewing "b": c must recycle "a" (the other idle), not the pinned "b".
    expect(selectFollowChildren(ws, "O", ["a", "b"], CAP, "b")).toEqual(["c", "b"]);
  });

  it("includeIdle=false: a running newcomer still recycles an idle slot", () => {
    const ws = [orch("O"), kid("a", "O", "IDLE"), kid("b", "O", "IDLE"), kid("c", "O", "WORKING")];
    expect(selectFollowChildren(ws, "O", ["a", "b"], CAP, null, false)).toEqual(["a", "c"]);
  });

  it("includeIdle=false: an off-screen idle child does NOT re-enter (no grid re-grow)", () => {
    // a + c shown; b is alive-IDLE but off-screen (recycled out earlier) → must stay out,
    // else the recycled idle pane reappears every tick and the grid grows back.
    const ws = [orch("O"), kid("a", "O", "IDLE"), kid("b", "O", "IDLE"), kid("c", "O", "WORKING")];
    expect(selectFollowChildren(ws, "O", ["a", "c"], CAP, null, false)).toEqual(["a", "c"]);
  });

  it("includeIdle=true: an off-screen idle child re-enters (anchor change / repopulate)", () => {
    const ws = [orch("O"), kid("a", "O", "IDLE"), kid("b", "O", "IDLE"), kid("c", "O", "WORKING")];
    expect(selectFollowChildren(ws, "O", ["a", "c"], CAP, null, true)).toEqual(["a", "c", "b"]);
  });

  it("includeIdle=false: two running newcomers recycle two idle slots — no growth", () => {
    const ws = [
      orch("O"),
      kid("a", "O", "IDLE", 0), kid("b", "O", "IDLE", 1),
      kid("c", "O", "WORKING", 2), kid("d", "O", "WORKING", 3),
    ];
    const out = selectFollowChildren(ws, "O", ["a", "b"], CAP, null, false);
    expect(out).toHaveLength(2);
    expect([...out].sort()).toEqual(["c", "d"]);
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
