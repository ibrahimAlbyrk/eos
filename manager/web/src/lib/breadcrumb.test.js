import { describe, it, expect } from "vitest";
import { breadcrumbFor } from "./breadcrumb.js";

const orch = { id: "o1", name: "dear-souls", is_orchestrator: 1, parent_id: null, cwd: "/Users/me/proj", worktree_from: null };
const worker = { id: "w1", name: "fix-tests", is_orchestrator: 0, parent_id: "o1", cwd: null, worktree_from: "/Users/me/proj" };

describe("breadcrumbFor", () => {
  it("no selection → project from fallback cwd, empty chain", () => {
    const r = breadcrumbFor([orch], null, "/tmp/other-proj");
    expect(r).toEqual({ project: "other-proj", chain: [] });
  });

  it("orchestrator selected → single-segment chain", () => {
    const r = breadcrumbFor([orch, worker], "o1");
    expect(r.project).toBe("proj");
    expect(r.chain).toEqual([{ id: "o1", label: "dear-souls" }]);
  });

  it("worker selected → root-first chain, project from the root", () => {
    const r = breadcrumbFor([orch, worker], "w1");
    expect(r.project).toBe("proj");
    expect(r.chain.map((s) => s.id)).toEqual(["o1", "w1"]);
  });

  it("parentless worktree worker → project from worktree_from", () => {
    const lone = { ...worker, id: "w2", parent_id: null };
    const r = breadcrumbFor([lone], "w2");
    expect(r.project).toBe("proj");
    expect(r.chain.map((s) => s.id)).toEqual(["w2"]);
  });

  it("missing parent row truncates the chain at the selected agent", () => {
    const stray = { ...worker, id: "w3", parent_id: "gone" };
    const r = breadcrumbFor([stray], "w3");
    expect(r.chain.map((s) => s.id)).toEqual(["w3"]);
  });

  it("parent cycle terminates", () => {
    const a = { ...worker, id: "a", parent_id: "b" };
    const b = { ...worker, id: "b", parent_id: "a" };
    const r = breadcrumbFor([a, b], "a");
    expect(r.chain.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("label falls back to Orchestrator / id when unnamed", () => {
    const unnamedOrch = { ...orch, id: "o2", name: null };
    const unnamedWorker = { ...worker, id: "w4", name: null, parent_id: "o2" };
    const r = breadcrumbFor([unnamedOrch, unnamedWorker], "w4");
    expect(r.chain.map((s) => s.label)).toEqual(["Orchestrator", "w4"]);
  });
});
