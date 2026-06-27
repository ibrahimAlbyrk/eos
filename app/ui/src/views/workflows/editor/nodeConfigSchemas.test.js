import { describe, it, expect } from "vitest";
import {
  CONFIG_SCHEMA_KINDS, CONTROL_TYPES, OPTION_KEYS,
  EFFORT_LEVELS, LOOP_STRATEGIES, PREDICATE_OPS,
  fieldsForKind, schemaForKind, setConfigField, isEmptyValue, bindingSuggestions,
} from "./nodeConfigSchemas.js";
// The contract is the source of truth — the schema set must never silently drift
// from it (the "can't drift" guard). Same cross-package import the other editor
// tests use (graphModel.test.js).
import { GRAPH_NODE_KINDS } from "../../../../../../contracts/src/workflow-graph.ts";
import { EFFORT_LEVELS as CONTRACT_EFFORTS } from "../../../../../../contracts/src/shared.ts";
import { LoopStrategySchema, SpawnLoopSchema } from "../../../../../../contracts/src/loop.ts";
import { PredicateSchema } from "../../../../../../contracts/src/workflow-node.ts";
import { createInitialGraph, addNode } from "./graphModel.js";

const find = (kind, key) => fieldsForKind(kind).find((f) => f.key === key);

describe("nodeConfigSchemas — coverage stays in sync with the contract", () => {
  it("covers exactly the 14 GRAPH_NODE_KINDS (no drift)", () => {
    expect([...CONFIG_SCHEMA_KINDS].sort()).toEqual([...GRAPH_NODE_KINDS].sort());
    expect(GRAPH_NODE_KINDS.length).toBe(14);
  });

  it("every field uses a known control and a known option source", () => {
    for (const kind of CONFIG_SCHEMA_KINDS) {
      for (const fld of fieldsForKind(kind)) {
        expect(CONTROL_TYPES, `${kind}.${fld.key} control`).toContain(fld.control);
        if (fld.optionsKey) expect(OPTION_KEYS, `${kind}.${fld.key} optionsKey`).toContain(fld.optionsKey);
      }
    }
  });

  it("io + merge kinds have no node-level config; merge documents fan-in order", () => {
    expect(fieldsForKind("input")).toEqual([]);
    expect(fieldsForKind("output")).toEqual([]);
    expect(fieldsForKind("merge")).toEqual([]);
    expect(schemaForKind("merge").note).toMatch(/fan-in/i);
  });
});

describe("nodeConfigSchemas — every enum field is a selector with the real values", () => {
  it("effort options match the contract EFFORT_LEVELS and gate on model", () => {
    expect(EFFORT_LEVELS).toEqual([...CONTRACT_EFFORTS]);
    const effort = find("worker", "effort");
    expect(effort.control).toBe("segmented");
    expect(effort.optionsKey).toBe("efforts");
    expect(effort.gatedBy).toBe("model");
  });

  it("model is a dropdown sourced from the model catalog", () => {
    const model = find("worker", "model");
    expect(model.control).toBe("select");
    expect(model.optionsKey).toBe("models");
  });

  it("transform-family fn is a dropdown sourced live from the catalog", () => {
    for (const kind of ["transform", "map", "filter", "dedup", "tally", "accumulate"]) {
      const fn = find(kind, "fn");
      expect(fn, `${kind}.fn`).toBeTruthy();
      expect(fn.control).toBe("select");
      expect(fn.optionsKey).toBe("transformFns");
    }
    // role hints reflect each kind's expected fn family.
    expect(find("filter", "fn").role).toBe("predicate");
    expect(find("accumulate", "fn").role).toBe("reducer");
    expect(find("dedup", "fn").role).toBe("key");
  });

  it("loop strategy options match the contract LoopStrategySchema", () => {
    expect(LOOP_STRATEGIES).toEqual(LoopStrategySchema.options);
  });

  it("predicate ops match what the contract PredicateSchema accepts", () => {
    expect(PREDICATE_OPS).toEqual(["eq", "exists", "and", "or"]);
    expect(() => PredicateSchema.parse({ op: "eq", left: "{{args.x}}" })).not.toThrow();
    expect(() => PredicateSchema.parse({ op: "exists", ref: "{{args.x}}" })).not.toThrow();
    expect(() => PredicateSchema.parse({ op: "and", clauses: [] })).not.toThrow();
    expect(() => PredicateSchema.parse({ op: "or", clauses: [] })).not.toThrow();
    expect(() => PredicateSchema.parse({ op: "nope", left: "x" })).toThrow();
  });

  it("branch/loop predicates + loop body + subGraph name use the right controls", () => {
    expect(find("branch", "predicate").control).toBe("predicate");
    expect(find("loop", "until").control).toBe("predicate");
    expect(find("loop", "body").control).toBe("sub-canvas");
    expect(find("subGraph", "name").control).toBe("select");
    expect(find("subGraph", "name").optionsKey).toBe("definitions");
  });

  it("worker from is a worker-definition dropdown; prompt is free text", () => {
    expect(find("worker", "from").control).toBe("select");
    expect(find("worker", "from").optionsKey).toBe("workerDefs");
    const prompt = find("worker", "prompt");
    expect(prompt.control).toBe("textarea");
    expect(prompt.required).toBe(true);
  });

  it("JSON-Schema + spawn-loop fields use their dedicated controls", () => {
    expect(find("worker", "outputSchema").control).toBe("json-schema");
    expect(find("worker", "loop").control).toBe("spawn-loop");
    // The spawn-loop control edits a value the contract SpawnLoopSchema accepts.
    expect(() => SpawnLoopSchema.parse({ goal: { summary: "s", criteria: [{ id: "c1", text: "t" }] } })).not.toThrow();
  });

  it("script kind carries the trust-gate flag (no run-inline)", () => {
    expect(schemaForKind("script").trustGate).toBe(true);
    expect(find("script", "script").control).toBe("text"); // a NAME, not a selector (no enumerable allowlist endpoint)
  });
});

describe("nodeConfigSchemas — config mutation helpers (the graphModel boundary)", () => {
  it("isEmptyValue treats blank/empty-array/nullish as omit, keeps 0 and false", () => {
    expect(isEmptyValue("")).toBe(true);
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue(false)).toBe(false);
  });

  it("setConfigField sets, deletes empties, and collapses an empty config to undefined", () => {
    let c = setConfigField(undefined, "prompt", "hi");
    expect(c).toEqual({ prompt: "hi" });
    c = setConfigField(c, "model", "opus");
    expect(c).toEqual({ prompt: "hi", model: "opus" });
    c = setConfigField(c, "model", ""); // clear → key removed
    expect(c).toEqual({ prompt: "hi" });
    c = setConfigField(c, "prompt", ""); // last key removed → undefined
    expect(c).toBeUndefined();
  });
});

describe("nodeConfigSchemas — binding-ref suggestions", () => {
  it("offers args/item + each other node's output, excluding self and io", () => {
    let g = createInitialGraph();
    const a = addNode(g, { kind: "worker", inputs: [], outputs: [] }); g = a.state;
    const b = addNode(g, { kind: "transform", inputs: [], outputs: [] }); g = b.state;
    const sug = bindingSuggestions(g, a.node.id);
    expect(sug).toContain("{{args}}");
    expect(sug).toContain("{{item}}");
    expect(sug).toContain(`{{nodes.${b.node.id}.output}}`);
    expect(sug).not.toContain(`{{nodes.${a.node.id}.output}}`); // self excluded
    expect(sug.some((s) => s.includes("input"))).toBe(false); // io excluded
  });
});
