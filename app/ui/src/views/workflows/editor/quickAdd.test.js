import { describe, it, expect } from "vitest";
import { firstCompatiblePort, compatibleKinds, addableKinds, filterKinds } from "./quickAdd.js";
import { isPortTypeAssignable } from "./portTypes.js";

// Mirrors the live catalog shape (core/domain workflow-node-catalog): default
// typed ports per kind. The spawn-menu filter must agree with isPortTypeAssignable.
const KINDS = [
  { kind: "input", label: "Input", category: "io", description: "graph entry", inputs: [], outputs: [{ name: "out", type: "any" }] },
  { kind: "output", label: "Output", category: "io", description: "graph exit", inputs: [{ name: "in", type: "any" }], outputs: [] },
  { kind: "worker", label: "Worker", category: "compute", description: "run a worker", inputs: [{ name: "in", type: "any" }], outputs: [{ name: "out", type: "any" }] },
  { kind: "map", label: "Map", category: "transform", description: "map over a list", inputs: [{ name: "in", type: "array" }], outputs: [{ name: "out", type: "array" }] },
  { kind: "tally", label: "Tally", category: "transform", description: "count a list", inputs: [{ name: "in", type: "array" }], outputs: [{ name: "out", type: "number" }] },
  { kind: "merge", label: "Merge", category: "control", description: "ordered join", inputs: [{ name: "in", type: "any" }], outputs: [{ name: "out", type: "any" }] },
];

describe("quickAdd — firstCompatiblePort picks the auto-wire target port", () => {
  it("from an output drag, returns the candidate's first input the source type assigns to", () => {
    expect(firstCompatiblePort(KINDS[3], "any", "out")).toBe("in"); // any → map.in(array) ok
    expect(firstCompatiblePort(KINDS[3], "number", "out")).toBe(null); // number → array no
    expect(firstCompatiblePort(KINDS[2], "number", "out")).toBe("in"); // number → worker.in(any) ok
  });

  it("from an input drag, returns the candidate's first output assignable to the source type", () => {
    expect(firstCompatiblePort(KINDS[3], "array", "in")).toBe("out"); // map.out(array) → array ok
    expect(firstCompatiblePort(KINDS[4], "array", "in")).toBe(null); // tally.out(number) → array no
  });
});

describe("quickAdd — compatibleKinds drives the drag-from-port spawn menu", () => {
  it("offers exactly the kinds whose auto-wire canConnect would accept (output drag)", () => {
    const got = compatibleKinds(KINDS, "number", "out").map((e) => e.kind).sort();
    expect(got).toEqual(["merge", "output", "worker"]); // map/tally need array in; input excluded
  });

  it("offers kinds with a compatible output for an input drag", () => {
    const got = compatibleKinds(KINDS, "array", "in").map((e) => e.kind).sort();
    expect(got).toEqual(["map", "merge", "worker"]); // tally.out number not assignable; input excluded
  });

  it("never offers `input` (singleton, no input port)", () => {
    expect(compatibleKinds(KINDS, "any", "out").some((e) => e.kind === "input")).toBe(false);
    expect(compatibleKinds(KINDS, "any", "in").some((e) => e.kind === "input")).toBe(false);
  });

  it("agrees with isPortTypeAssignable for every offered kind", () => {
    for (const e of compatibleKinds(KINDS, "number", "out")) {
      const port = e.inputs.find((p) => p.name === firstCompatiblePort(e, "number", "out"));
      expect(isPortTypeAssignable("number", port.type)).toBe(true);
    }
  });
});

describe("quickAdd — addableKinds + filterKinds for the quick-add search", () => {
  it("blocks a second input when the graph already has one", () => {
    expect(addableKinds(KINDS, { hasInput: true }).some((e) => e.kind === "input")).toBe(false);
    expect(addableKinds(KINDS, { hasInput: false }).some((e) => e.kind === "input")).toBe(true);
  });

  it("filters by case-insensitive substring across label/kind/description", () => {
    expect(filterKinds(KINDS, "mer").map((e) => e.kind)).toEqual(["merge"]);
    expect(filterKinds(KINDS, "LIST").map((e) => e.kind).sort()).toEqual(["map", "tally"]); // both descriptions
    expect(filterKinds(KINDS, "").length).toBe(KINDS.length);
  });
});
