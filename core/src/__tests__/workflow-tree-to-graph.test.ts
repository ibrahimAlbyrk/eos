import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { wf } from "../workflow/dsl.ts";
import { treeToGraph } from "../workflow/tree-to-graph.ts";
import { WorkflowGraphSchema, type WorkflowGraph, type GraphNode } from "../../../contracts/src/workflow-graph.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";

const INPUT = "__input__";
const OUTPUT = "__output__";

// Compile + assert the result is a structurally-valid v2 graph (the schema's
// superRefine catches dangling edges, duplicate ids, cardinality, cycles).
function compile(def: WorkflowDefinition): WorkflowGraph {
  const g = treeToGraph(def);
  const parsed = WorkflowGraphSchema.safeParse(g);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 2));
  return g;
}

function node(g: WorkflowGraph, id: string): GraphNode | undefined {
  return g.nodes.find((n) => n.id === id);
}
function hasEdge(g: WorkflowGraph, fn: string, fp: string, tn: string, tp: string): boolean {
  return g.edges.some((e) => e.from.node === fn && e.from.port === fp && e.to.node === tn && e.to.port === tp);
}
function sourcesInto(g: WorkflowGraph, toNode: string): string[] {
  return g.edges.filter((e) => e.to.node === toNode).map((e) => e.from.node);
}
function kinds(g: WorkflowGraph): Record<string, string> {
  return Object.fromEntries(g.nodes.map((n) => [n.id, n.kind]));
}

describe("treeToGraph — framing", () => {
  it("always adds exactly one input and one output node", () => {
    const g = compile(wf.define("w", (b) => ({ root: b.step({ id: "s", prompt: "hi" }) })));
    assert.equal(g.nodes.filter((n) => n.kind === "input").length, 1);
    assert.equal(g.nodes.filter((n) => n.kind === "output").length, 1);
    assert.equal(g.version, 2);
    // the single leaf is wired input → worker → output
    assert.equal(node(g, "s")?.kind, "worker");
    assert.ok(hasEdge(g, INPUT, "out", "s", "in"));
    assert.ok(hasEdge(g, "s", "out", OUTPUT, "in"));
  });

  it("carries name / description / experts / argsSchema through", () => {
    const def = wf.define("named", (b) => ({
      description: "d",
      experts: [{ id: "x", prompt: "p" }],
      root: b.step({ id: "s", prompt: "hi" }),
    }));
    const withArgs: WorkflowDefinition = { ...def, argsSchema: { type: "object" } };
    const g = compile(withArgs);
    assert.equal(g.name, "named");
    assert.equal(g.description, "d");
    assert.deepEqual(g.experts, [{ id: "x", prompt: "p" }]);
    assert.deepEqual(g.argsSchema, { type: "object" });
    // argsSchema lights up the input node's out-port type
    assert.equal(node(g, INPUT)?.outputs?.[0].type, "json");
  });
});

describe("treeToGraph — sequence", () => {
  it("lowers sequence ordering to control edges and {{nodes}} refs to data edges", () => {
    const g = compile(wf.define("seq", (b) => ({
      root: b.sequence([
        b.step({ id: "a", prompt: "do {{args.x}}" }),
        b.step({ id: "c", prompt: "use {{nodes.a.output}}" }),
      ]),
    })));
    // no standalone node for the sequence container itself
    assert.equal(g.nodes.filter((n) => n.kind === "worker").length, 2);
    // ordering: a → c (control), and a's output feeds c's "a" data port
    assert.ok(hasEdge(g, "a", "out", "c", "in"), "sequence control edge a→c");
    assert.ok(hasEdge(g, "a", "out", "c", "a"), "data edge for {{nodes.a.output}}");
    // args ref wires from the input node
    assert.ok(hasEdge(g, INPUT, "out", "a", "args"), "data edge for {{args.x}}");
    // the run output is the last child's output
    assert.ok(hasEdge(g, "c", "out", OUTPUT, "in"));
  });
});

describe("treeToGraph — parallel", () => {
  it("fans out children and re-converges them into a single merge node (ordered)", () => {
    const g = compile(wf.define("par", (b) => ({
      root: b.parallel([
        b.step({ id: "a", prompt: "x" }),
        b.step({ id: "b2", prompt: "y" }),
      ]),
    })));
    const merge = g.nodes.find((n) => n.kind === "merge");
    assert.ok(merge, "parallel produces a merge fan-in node");
    // both children start from the input, both fan into the merge in order
    assert.ok(hasEdge(g, INPUT, "out", "a", "in"));
    assert.ok(hasEdge(g, INPUT, "out", "b2", "in"));
    assert.deepEqual(sourcesInto(g, merge!.id), ["a", "b2"]);
    assert.ok(hasEdge(g, merge!.id, "out", OUTPUT, "in"));
  });
});

describe("treeToGraph — conditional", () => {
  it("lowers conditional to a branch node + a merge re-convergence node", () => {
    const g = compile(wf.define("cond", (b) => ({
      root: b.conditional({
        id: "cond",
        predicate: { op: "exists", ref: "args.flag" },
        then: b.step({ id: "t", prompt: "then" }),
        else: b.step({ id: "e", prompt: "else" }),
      }),
    })));
    assert.equal(node(g, "cond")?.kind, "branch");
    assert.equal(node(g, "cond::merge")?.kind, "merge");
    // branch fans to each arm on its own port; arms re-converge at the merge
    assert.ok(hasEdge(g, "cond", "then", "t", "in"));
    assert.ok(hasEdge(g, "cond", "else", "e", "in"));
    assert.deepEqual(sourcesInto(g, "cond::merge").sort(), ["e", "t"]);
    // the predicate's args ref is a data edge into the branch
    assert.ok(hasEdge(g, INPUT, "out", "cond", "args"));
    assert.ok(hasEdge(g, "cond::merge", "out", OUTPUT, "in"));
  });

  it("HIGH-2: does NOT drain the else port into the merge when there is no else arm", () => {
    const g = compile(wf.define("cond2", (b) => ({
      root: b.conditional({
        id: "c2",
        predicate: { op: "exists", ref: "args.f" },
        then: b.step({ id: "t2", prompt: "x" }),
      }),
    })));
    // The spurious else→merge drain edge is gone: a false predicate must NOT deliver
    // a passed token to the merge (that flipped a skipped conditional to passed). The
    // merge re-converges via the then-arm only (skipped when the predicate is false).
    assert.ok(!hasEdge(g, "c2", "else", "c2::merge", "in"), "no spurious else→merge drain edge");
    assert.ok(hasEdge(g, "t2", "out", "c2::merge", "in"));
    assert.ok(hasEdge(g, "c2::merge", "out", OUTPUT, "in"));
  });
});

describe("treeToGraph — forEach (loop with encapsulated body sub-graph)", () => {
  it("lowers forEach to a loop node whose config.body is a valid sub-graph", () => {
    const g = compile(wf.define("fe", (b) => ({
      root: b.forEach({
        id: "loop",
        over: "{{args.items}}",
        body: b.step({ id: "item-step", prompt: "handle {{item}}" }),
      }),
    })));
    const loop = node(g, "loop");
    assert.equal(loop?.kind, "loop");
    const cfg = loop?.config as { loopKind: string; over: string; body: unknown };
    assert.equal(cfg.loopKind, "forEach");
    assert.equal(cfg.over, "{{args.items}}");
    // the over list is a data edge into the loop
    assert.ok(hasEdge(g, INPUT, "out", "loop", "args"));
    // there is no standalone graph node for the body step at the top level
    assert.equal(node(g, "item-step"), undefined);

    // the body is itself a valid v2 graph: input seeds {{item}}, output carries result
    const body = WorkflowGraphSchema.safeParse(cfg.body);
    assert.ok(body.success, body.success ? "" : JSON.stringify(body.error.issues));
    const bodyGraph = cfg.body as WorkflowGraph;
    assert.equal(node(bodyGraph, "item-step")?.kind, "worker");
    assert.ok(hasEdge(bodyGraph, INPUT, "item", "item-step", "item"), "loop local {{item}} wired from body input");
    assert.ok(hasEdge(bodyGraph, "item-step", "out", OUTPUT, "in"));
  });
});

describe("treeToGraph — glue + loopUntil", () => {
  it("maps each glue transform to a same-named kind with an over data edge", () => {
    const g = compile(wf.define("glue", (b) => ({
      root: b.sequence([
        b.step({ id: "src", prompt: "make a list" }),
        b.dedup({ id: "d", over: "{{nodes.src.output}}" }),
      ]),
    })));
    assert.equal(node(g, "d")?.kind, "dedup");
    assert.ok(hasEdge(g, "src", "out", "d", "src"), "glue over ref → data edge");
  });

  it("FIX #3: a loopUntil whose `until` reads its own lastCount emits NO self-edge", () => {
    const g = compile(wf.define("lu-self", (b) => ({
      root: b.loopUntil({
        id: "lu",
        body: b.step({ id: "tick", prompt: "go {{iteration}}" }),
        until: { op: "eq", left: "{{nodes.lu.lastCount}}", right: 0 },
        maxIterations: 5,
      }),
    })));
    // The `until` reads the loop's OWN running state — that flows via BindingScope
    // each round, never the frontier — so it must NOT compile to a self-edge (which
    // the runtime would only have to defensively drop) nor a spurious self input port.
    assert.ok(!g.edges.some((e) => e.from.node === "lu" && e.to.node === "lu"), "no lu→lu self-edge");
    assert.ok(!(node(g, "lu")?.inputs ?? []).some((p) => p.name === "lu"), "no self input port on the loop");
  });

  it("maps loopUntil to a loop node carrying until + maxIterations", () => {
    const g = compile(wf.define("lu", (b) => ({
      root: b.loopUntil({
        id: "lu",
        body: b.step({ id: "tick", prompt: "iterate {{iteration}}" }),
        maxIterations: 3,
      }),
    })));
    const cfg = node(g, "lu")?.config as { loopKind: string; maxIterations: number };
    assert.equal(node(g, "lu")?.kind, "loop");
    assert.equal(cfg.loopKind, "loopUntil");
    assert.equal(cfg.maxIterations, 3);
  });
});

describe("treeToGraph — glob fan-in is deterministic", () => {
  const def = wf.define("rap-lite", (b) => ({
    root: b.sequence([
      b.parallel([
        b.step({ id: "r-0", prompt: "{{args.t}}" }),
        b.step({ id: "r-1", prompt: "{{args.t}}" }),
        b.step({ id: "r-2", prompt: "{{args.t}}" }),
      ]),
      b.step({ id: "agg", prompt: "all: {{nodes.r-*.output}}" }),
    ]),
  }));

  it("collects glob matches into a merge node in sorted id order", () => {
    const g = compile(def);
    const globMerge = node(g, "__glob__:r-*");
    assert.equal(globMerge?.kind, "merge");
    assert.deepEqual(sourcesInto(g, "__glob__:r-*"), ["r-0", "r-1", "r-2"]);
    assert.ok(hasEdge(g, "__glob__:r-*", "out", "agg", "r-*"));
  });

  it("is pure + deterministic — compiling twice yields identical graphs", () => {
    assert.deepEqual(treeToGraph(def), treeToGraph(def));
  });
});

describe("treeToGraph — every v1 node type compiles", () => {
  // A raw tree exercising all 16 node types (the DSL hides `script`, so build the
  // tree literally). The compiler must be total over the union without throwing.
  const allTypes: WorkflowDefinition = {
    name: "all",
    root: {
      type: "sequence", id: "root", children: [
        { type: "step", id: "s", prompt: "p" },
        { type: "script", id: "sc", script: "x", over: "{{nodes.s.output}}" },
        { type: "transform", id: "tr", fn: "f", over: "{{nodes.sc.output}}" },
        { type: "map", id: "mp", fn: "f", over: "{{nodes.tr.output}}" },
        { type: "filter", id: "fl", fn: "f", over: "{{nodes.mp.output}}" },
        { type: "dedup", id: "dd", over: "{{nodes.fl.output}}" },
        { type: "tally", id: "ta", over: "{{nodes.fl.output}}" },
        { type: "accumulate", id: "ac", fn: "f", over: "{{nodes.fl.output}}", init: 0 },
        { type: "parallel", id: "pp", children: [{ type: "step", id: "pa", prompt: "x" }] },
        { type: "subWorkflow", id: "sw", name: "child" },
        { type: "phase", id: "ph", label: "ph", body: { type: "step", id: "ps", prompt: "p" } },
        { type: "pipeline", id: "pl", over: "{{nodes.s.output}}", stages: [{ type: "step", id: "stg", prompt: "{{item}}" }] },
        { type: "forEach", id: "fe", over: "{{args.x}}", body: { type: "step", id: "fitem", prompt: "{{item}}" } },
        { type: "loopUntil", id: "lu", body: { type: "step", id: "lt", prompt: "x" }, maxIterations: 2 },
        { type: "conditional", id: "cn", predicate: { op: "exists", ref: "args.f" }, then: { type: "step", id: "ct", prompt: "x" } },
      ],
    },
  };

  it("covers the full union without throwing and stays schema-valid", () => {
    const g = compile(allTypes);
    assert.equal(node(g, "s")?.kind, "worker");
    assert.equal(node(g, "sc")?.kind, "script");
    assert.equal(node(g, "tr")?.kind, "transform");
    assert.equal(node(g, "ac")?.kind, "accumulate");
    assert.equal(node(g, "sw")?.kind, "subGraph");
    assert.equal(node(g, "pl")?.kind, "loop");
    assert.equal(node(g, "fe")?.kind, "loop");
    assert.equal(node(g, "lu")?.kind, "loop");
    assert.equal(node(g, "cn")?.kind, "branch");
    // script over ref → data edge
    assert.ok(hasEdge(g, "s", "out", "sc", "s"));
    // phase is pass-through: its label lands on the body node, no phase node exists
    assert.equal(kinds(g)["ph"], undefined);
    assert.equal(node(g, "ps")?.label, "ph");
  });
});
