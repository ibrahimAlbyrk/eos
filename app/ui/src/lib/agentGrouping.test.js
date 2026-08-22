import { describe, it, expect } from "vitest";
import { groupAgents, groupByDate, groupByCustom, UNGROUPED_KEY } from "./agentGrouping.js";

const r = (id, extra = {}) => ({ id, cwd: null, worktree_from: null, started_at: 0, ...extra });

describe("groupAgents folder mode", () => {
  it("delegates to project grouping and carries path", () => {
    const groups = groupAgents(
      [r("a", { cwd: "/Users/me/proj" }), r("b", { cwd: null })],
      "folder",
    );
    expect(groups.map((g) => g.name)).toEqual(["proj", "Other"]);
    expect(groups[0].path).toBe("/Users/me/proj");
  });
});

describe("groupByDate", () => {
  // Fixed "now" = 2026-08-22 12:00 local; buckets are calendar-day relative.
  const now = new Date(2026, 7, 22, 12, 0, 0).getTime();
  const at = (y, mo, d, h = 10) => new Date(y, mo, d, h).getTime();

  it("buckets by created day, newest bucket first, empties omitted", () => {
    const groups = groupByDate([
      r("today1", { started_at: at(2026, 7, 22, 9) }),
      r("older1", { started_at: at(2026, 1, 1) }),
      r("yest1", { started_at: at(2026, 7, 21, 23) }),
      r("week1", { started_at: at(2026, 7, 18) }),
      r("today2", { started_at: at(2026, 7, 22, 1) }),
    ], now);
    expect(groups.map((g) => g.name)).toEqual(["Today", "Yesterday", "This week", "Older"]);
    expect(groups[0].roots.map((x) => x.id)).toEqual(["today1", "today2"]);
    expect(groups[1].roots.map((x) => x.id)).toEqual(["yest1"]);
    expect(groups[3].roots.map((x) => x.id)).toEqual(["older1"]);
  });

  it("omits buckets with no members", () => {
    const groups = groupByDate([r("t", { started_at: now })], now);
    expect(groups.map((g) => g.key)).toEqual(["today"]);
  });
});

describe("groupByCustom", () => {
  const groups = [{ id: "g1", name: "Alpha" }, { id: "g2", name: "Beta" }];

  it("groups by assignment in defined order, Ungrouped last", () => {
    const out = groupByCustom(
      [r("a"), r("b"), r("c")],
      groups,
      { a: "g2", b: "g1" },
    );
    expect(out.map((g) => g.name)).toEqual(["Alpha", "Beta", "Ungrouped"]);
    expect(out[0].roots.map((x) => x.id)).toEqual(["b"]);
    expect(out[1].roots.map((x) => x.id)).toEqual(["a"]);
    expect(out[2].key).toBe(UNGROUPED_KEY);
    expect(out[2].roots.map((x) => x.id)).toEqual(["c"]);
  });

  it("omits empty custom groups and Ungrouped when everything is assigned", () => {
    const out = groupByCustom([r("a")], groups, { a: "g1" });
    expect(out.map((g) => g.name)).toEqual(["Alpha"]);
  });

  it("treats a stale assignment (deleted group) as Ungrouped", () => {
    const out = groupByCustom([r("a")], groups, { a: "gone" });
    expect(out.map((g) => g.key)).toEqual([UNGROUPED_KEY]);
  });
});
