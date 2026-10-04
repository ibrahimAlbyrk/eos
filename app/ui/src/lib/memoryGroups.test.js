import { describe, it, expect } from "vitest";
import { memoryFilters, memoryGroups, projectLabel, sourceLabel } from "./memoryGroups.js";

let seq = 0;
const mem = (text, over = {}) => ({
  id: `um-g${++seq}`, text, category: "work-style", scope: { kind: "global" }, tier: "always",
  status: "active", source: { kind: "user" }, rev: 0, createdAt: seq, updatedAt: seq, ...over,
});

const MEMS = [
  mem("Call me Ibrahim.", { category: "about" }),
  mem("Be concise."),
  mem("Ask when unclear."),
  mem("TypeScript, React.", { category: "stack" }),
  mem("Never run eos build.", { scope: { kind: "project", path: "/Users/me/eos" } }),
  mem("Pending thing.", { status: "suggested" }),
];

describe("memoryGroups", () => {
  it("kept memories by category in table order, then per project; newest first", () => {
    const groups = memoryGroups(MEMS);
    expect(groups.map((g) => g.label)).toEqual(["About me", "How I work", "Stack", "eos"]);
    expect(groups[1].items.map((m) => m.text)).toEqual(["Ask when unclear.", "Be concise."]);
    expect(groups[3].project).toBe("/Users/me/eos");
    expect(groups.flatMap((g) => g.items).some((m) => m.status === "suggested")).toBe(false);
  });

  it("query and filter narrow it", () => {
    expect(memoryGroups(MEMS, { query: "CONCISE" }).flatMap((g) => g.items).map((m) => m.text)).toEqual(["Be concise."]);
    expect(memoryGroups(MEMS, { filter: "cat:stack" }).map((g) => g.label)).toEqual(["Stack"]);
  });

  it("filter chips count each group, All counts every kept memory", () => {
    const f = memoryFilters(MEMS);
    expect(f[0]).toEqual({ key: "all", label: "All", count: 5 });
    expect(f.find((x) => x.key === "project:/Users/me/eos").count).toBe(1);
    expect(memoryFilters(null)).toEqual([{ key: "all", label: "All", count: 0 }]);
  });

  it("labels", () => {
    expect(projectLabel("/Users/me/eos/")).toBe("eos");
    expect(sourceLabel(mem("x", { source: { kind: "agent", agentId: "w", agentName: "find-bar" } }))).toBe("Learned · find-bar");
    expect(sourceLabel(mem("x", { source: { kind: "import", from: "CLAUDE.md" } }))).toBe("Imported");
    expect(sourceLabel(mem("x"))).toBe("You");
  });
});
