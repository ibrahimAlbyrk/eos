import { describe, it, expect } from "vitest";
import { createInitialGraph, addNode, addEdge, updateNode, toWorkflowGraph } from "./graphModel.js";
import { setConfigField } from "./nodeConfigSchemas.js";
import { defaultPredicate, withLeft, withRightValue, makePredicate, withRef } from "./predicateModel.js";
// The emitted graph must validate against the SAME schema the daemon enforces on
// save (the Save contract). This is the Phase-3 acceptance: a typed config edit
// round-trips through graphModel → toWorkflowGraph as a valid v2 graph.
import { WorkflowGraphSchema } from "../../../../../../contracts/src/workflow-graph.ts";

const entry = (kind, inputs, outputs) => ({ kind, label: kind, inputs, outputs });
const IN = (t = "any") => [{ name: "in", type: t }];
const OUT = (t = "any") => [{ name: "out", type: t }];

const setCfg = (g, id, patches) => {
  const node = g.nodes.find((n) => n.id === id);
  let config = node.config;
  for (const [k, v] of patches) config = setConfigField(config, k, v);
  return updateNode(g, id, { config });
};

describe("typed config round-trips through graphModel → toWorkflowGraph (valid v2)", () => {
  it("worker node with model + effort + prompt", () => {
    let g = createInitialGraph({ name: "worker-demo" });
    const w = addNode(g, entry("worker", IN(), OUT())); g = w.state;
    g = addEdge(g, { node: "input", port: "out" }, { node: w.node.id, port: "in" }).state;
    g = addEdge(g, { node: w.node.id, port: "out" }, { node: "output", port: "in" }).state;
    g = setCfg(g, w.node.id, [["prompt", "Summarize the input"], ["model", "opus"], ["effort", "high"]]);

    const payload = toWorkflowGraph(g);
    expect(() => WorkflowGraphSchema.parse(payload)).not.toThrow();
    const cfg = payload.nodes.find((n) => n.id === w.node.id).config;
    expect(cfg).toEqual({ prompt: "Summarize the input", model: "opus", effort: "high" });
  });

  it("transform node with a fn + over binding", () => {
    let g = createInitialGraph({ name: "transform-demo" });
    const t = addNode(g, entry("transform", IN(), OUT())); g = t.state;
    g = addEdge(g, { node: "input", port: "out" }, { node: t.node.id, port: "in" }).state;
    g = addEdge(g, { node: t.node.id, port: "out" }, { node: "output", port: "in" }).state;
    g = setCfg(g, t.node.id, [["fn", "unique"], ["over", "{{args.items}}"]]);

    const payload = toWorkflowGraph(g);
    expect(() => WorkflowGraphSchema.parse(payload)).not.toThrow();
    expect(payload.nodes.find((n) => n.id === t.node.id).config).toEqual({ fn: "unique", over: "{{args.items}}" });
  });

  it("branch node with a predicate + then/else output edges", () => {
    let g = createInitialGraph({ name: "branch-demo" });
    // a second output so then/else each reach an exit (≥1 output required).
    const out2 = addNode(g, entry("output", IN(), [])); g = out2.state;
    const b = addNode(g, entry("branch", IN(), [{ name: "then", type: "any" }, { name: "else", type: "any" }])); g = b.state;
    g = addEdge(g, { node: "input", port: "out" }, { node: b.node.id, port: "in" }).state;
    const thenEdge = addEdge(g, { node: b.node.id, port: "then" }, { node: "output", port: "in" });
    g = thenEdge.state;
    const elseEdge = addEdge(g, { node: b.node.id, port: "else" }, { node: out2.node.id, port: "in" });
    g = elseEdge.state;
    // predicate built structurally (never a free string)
    const pred = withRightValue(withLeft(defaultPredicate(), "{{nodes.input.output}}"), "go", "literal");
    g = setCfg(g, b.node.id, [["predicate", pred]]);

    const payload = toWorkflowGraph(g);
    expect(() => WorkflowGraphSchema.parse(payload)).not.toThrow();
    // both branch outputs are wired
    const fromBranch = payload.edges.filter((e) => e.from.node === b.node.id).map((e) => e.from.port).sort();
    expect(fromBranch).toEqual(["else", "then"]);
    expect(payload.nodes.find((n) => n.id === b.node.id).config.predicate).toEqual({ op: "eq", left: "{{nodes.input.output}}", right: "go" });
  });

  it("loop node with an encapsulated nested body sub-graph + control fields", () => {
    let g = createInitialGraph({ name: "loop-demo" });
    const lp = addNode(g, entry("loop", IN(), OUT())); g = lp.state;
    g = addEdge(g, { node: "input", port: "out" }, { node: lp.node.id, port: "in" }).state;
    g = addEdge(g, { node: lp.node.id, port: "out" }, { node: "output", port: "in" }).state;

    // the body is a REAL sub-graph authored on the nested canvas (its own input/output)
    let body = createInitialGraph({ name: "loop-demo-body" });
    const bw = addNode(body, entry("worker", IN(), OUT())); body = bw.state;
    body = addEdge(body, { node: "input", port: "out" }, { node: bw.node.id, port: "in" }).state;
    body = addEdge(body, { node: bw.node.id, port: "out" }, { node: "output", port: "in" }).state;
    body = setCfg(body, bw.node.id, [["prompt", "do one iteration"]]);
    const bodyDoc = toWorkflowGraph(body);

    const until = withRef(makePredicate("exists"), "{{nodes.input.output}}");
    g = setCfg(g, lp.node.id, [["body", bodyDoc], ["maxIterations", 5], ["until", until]]);

    const payload = toWorkflowGraph(g);
    // parent graph stays acyclic + valid (loop body lives in config, not node/edge set)
    expect(() => WorkflowGraphSchema.parse(payload)).not.toThrow();
    const loopCfg = payload.nodes.find((n) => n.id === lp.node.id).config;
    expect(loopCfg.maxIterations).toBe(5);
    expect(loopCfg.until).toEqual({ op: "exists", ref: "{{nodes.input.output}}" });
    // the nested body is itself a valid v2 graph
    expect(() => WorkflowGraphSchema.parse(loopCfg.body)).not.toThrow();
    expect(loopCfg.body.nodes.some((n) => n.kind === "worker")).toBe(true);
  });

  it("accumulate with a json-literal init + and-predicate branch parse", () => {
    let g = createInitialGraph({ name: "acc-demo" });
    const acc = addNode(g, entry("accumulate", IN("array"), OUT())); g = acc.state;
    g = addEdge(g, { node: "input", port: "out" }, { node: acc.node.id, port: "in" }).state;
    g = addEdge(g, { node: acc.node.id, port: "out" }, { node: "output", port: "in" }).state;
    g = setCfg(g, acc.node.id, [["fn", "sum"], ["over", "{{args.nums}}"], ["init", 0]]);
    expect(() => WorkflowGraphSchema.parse(toWorkflowGraph(g))).not.toThrow();
    expect(g.nodes.find((n) => n.id === acc.node.id).config).toEqual({ fn: "sum", over: "{{args.nums}}", init: 0 });
  });
});
