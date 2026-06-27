import { describe, it, expect } from "vitest";
import { normalizeCatalog, paletteGroups } from "./catalog.js";

// Shape mirrors GET /workflows/catalog (manager builds it from
// buildWorkflowNodeCatalog + the live transform-fn names).
const MOCK_CATALOG = {
  nodeKinds: [
    { kind: "input", label: "Input", category: "io", inputs: [], outputs: [{ name: "out", type: "any" }] },
    { kind: "worker", label: "Worker", category: "compute", inputs: [{ name: "in" }], outputs: [{ name: "out" }] },
    { kind: "tally", label: "Tally", category: "transform", inputs: [{ name: "in", type: "array" }], outputs: [{ name: "out", type: "number" }] },
  ],
  transformFns: ["identity", "dedup"],
};

describe("catalog normalization (palette source)", () => {
  it("renders the node kinds from a mocked catalog response", () => {
    const c = normalizeCatalog(MOCK_CATALOG);
    expect(c.kinds.map((k) => k.kind)).toEqual(["input", "worker", "tally"]);
    expect(c.byKind.tally.outputs[0].type).toBe("number");
    expect(c.transformFns).toEqual(["identity", "dedup"]);
  });

  it("defaults an undeclared port type to `any`", () => {
    const c = normalizeCatalog(MOCK_CATALOG);
    expect(c.byKind.worker.outputs[0].type).toBe("any");
    expect(c.byKind.worker.inputs[0].type).toBe("any");
  });

  it("groups the palette by category in a stable order", () => {
    const groups = paletteGroups(normalizeCatalog(MOCK_CATALOG).kinds);
    expect(groups.map((g) => g.category)).toEqual(["io", "compute", "transform"]);
    expect(groups[0].entries.map((e) => e.kind)).toEqual(["input"]);
  });

  it("degrades safely on an empty/missing response", () => {
    expect(normalizeCatalog(null).kinds).toEqual([]);
    expect(normalizeCatalog({}).transformFns).toEqual([]);
  });
});
