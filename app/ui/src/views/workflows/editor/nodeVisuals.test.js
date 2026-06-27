import { describe, it, expect } from "vitest";
import {
  NODE_CATEGORIES,
  kindCategory,
  categoryAccentVar,
  kindAccentVar,
  kindIcon,
  nodeCardClass,
} from "./nodeVisuals.js";

// The full authoring vocabulary (contracts GRAPH_NODE_KINDS / domain catalog). The
// map must cover every one — a kind with no category renders as a colorless card.
const ALL_KINDS = [
  "input", "output", "worker", "script", "transform", "map", "filter",
  "dedup", "tally", "accumulate", "branch", "merge", "loop", "subGraph",
];

describe("nodeVisuals — kind → category / accent / icon", () => {
  it("maps all 14 node kinds to a known category, an accent token, and a non-empty icon", () => {
    expect(ALL_KINDS).toHaveLength(14);
    for (const kind of ALL_KINDS) {
      const cat = kindCategory(kind);
      expect(NODE_CATEGORIES).toContain(cat);
      expect(kindAccentVar(kind)).toBe(categoryAccentVar(cat));
      expect(kindAccentVar(kind)).toMatch(/^--wfk-/);
      const icon = kindIcon(kind);
      expect(Array.isArray(icon)).toBe(true);
      expect(icon.length).toBeGreaterThan(0);
      for (const el of icon) expect(typeof el.t).toBe("string");
    }
  });

  it("places the kinds into the documented categories", () => {
    expect(kindCategory("input")).toBe("io");
    expect(kindCategory("worker")).toBe("compute");
    expect(kindCategory("map")).toBe("transform");
    expect(kindCategory("branch")).toBe("control");
    expect(kindCategory("subGraph")).toBe("composite");
  });

  it("maps each category to its editor-scoped --wfk accent token", () => {
    expect(categoryAccentVar("io")).toBe("--wfk-io");
    expect(categoryAccentVar("compute")).toBe("--wfk-compute");
    expect(categoryAccentVar("transform")).toBe("--wfk-transform");
    expect(categoryAccentVar("control")).toBe("--wfk-control");
    expect(categoryAccentVar("composite")).toBe("--wfk-composite");
  });

  it("falls back to compute / the worker glyph for an unknown kind", () => {
    expect(kindCategory("nope")).toBe("compute");
    expect(categoryAccentVar("nope")).toBe("--wfk-compute");
    expect(kindIcon("nope")).toBe(kindIcon("worker"));
  });
});

describe("nodeVisuals — nodeCardClass state derivation", () => {
  it("always includes the base + category accent class", () => {
    const cls = nodeCardClass("worker");
    expect(cls).toContain("wf-rf-node");
    expect(cls).toContain("wf-rf-node--cat-compute");
    expect(cls).not.toContain("--selected");
    expect(cls).not.toContain("--running");
  });

  it("adds the selected modifier when selected", () => {
    expect(nodeCardClass("input", { selected: true })).toContain("wf-rf-node--selected");
  });

  it("adds exactly one run-state modifier from the live status", () => {
    expect(nodeCardClass("worker", { status: "running" })).toContain("wf-rf-node--running");
    expect(nodeCardClass("worker", { status: "passed" })).toContain("wf-rf-node--passed");
    expect(nodeCardClass("worker", { status: "failed" })).toContain("wf-rf-node--failed");
    expect(nodeCardClass("worker", { status: "skipped" })).toContain("wf-rf-node--skipped");
  });

  it("combines category, selection, and status together", () => {
    const cls = nodeCardClass("branch", { selected: true, status: "running" });
    expect(cls.split(" ").sort()).toEqual(
      ["wf-rf-node", "wf-rf-node--cat-control", "wf-rf-node--running", "wf-rf-node--selected"].sort(),
    );
  });
});
