import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compileJsonSchema, attachOutputValidators, attachGraphPortValidators } from "../json-schema-validator.ts";
import { buildEngine, spawnPort, type SpawnResponse } from "../../../core/src/__tests__/helpers/workflowFakes.ts";
import type { WorkflowNode } from "../../../contracts/src/workflow-node.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";
import { WORKFLOW_GRAPH_VERSION, type WorkflowGraph } from "../../../contracts/src/workflow-graph.ts";
import type { RunContext } from "../../../core/src/ports/WorkflowEngine.ts";

const ok = (schema: unknown, value: unknown) => assert.equal(compileJsonSchema(schema).safeParse(value).success, true);
const bad = (schema: unknown, value: unknown) => assert.equal(compileJsonSchema(schema).safeParse(value).success, false);

describe("compileJsonSchema — the orchestrator's JSON-Schema subset", () => {
  it("object: enforces required fields and validates declared properties", () => {
    const schema = { type: "object", properties: { facts: { type: "array", items: { type: "string" } } }, required: ["facts"] };
    ok(schema, { facts: ["a", "b"] });
    ok(schema, { facts: [], extra: 1 }); // unknown props pass (permissive)
    bad(schema, {});                      // missing required
    bad(schema, { facts: "not-an-array" });
    bad(schema, { facts: [1, 2] });       // item type mismatch
  });

  it("array + items", () => {
    const schema = { type: "array", items: { type: "number" } };
    ok(schema, [1, 2, 3]);
    bad(schema, [1, "x"]);
    bad(schema, "nope");
  });

  it("primitives: string / number / integer / boolean", () => {
    ok({ type: "string" }, "x"); bad({ type: "string" }, 1);
    ok({ type: "number" }, 1.5); bad({ type: "number" }, "1");
    ok({ type: "integer" }, 3); bad({ type: "integer" }, 3.5);
    ok({ type: "boolean" }, true); bad({ type: "boolean" }, "true");
  });

  it("enum: value must be a member", () => {
    ok({ enum: ["a", "b"] }, "a");
    bad({ enum: ["a", "b"] }, "c");
  });

  it("nullable: via `nullable:true` and via a `type` array carrying \"null\"", () => {
    ok({ type: "string", nullable: true }, null);
    ok({ type: ["string", "null"] }, null);
    ok({ type: ["string", "null"] }, "x");
    bad({ type: "string" }, null);
  });

  it("the returned data is the value unchanged (validation, not transformation)", () => {
    const value = { facts: ["a"] };
    const parsed = compileJsonSchema({ type: "object", required: ["facts"] }).safeParse(value);
    assert.equal(parsed.success, true);
    assert.equal((parsed as { data: unknown }).data, value);
  });
});

describe("attachOutputValidators — wraps inline JSON-Schema into the executor's ZodLike", () => {
  const hasSafeParse = (n: WorkflowNode): boolean =>
    n.type === "step" && typeof (n.outputSchema as { safeParse?: unknown })?.safeParse === "function";

  it("attaches a safeParse validator to a nested step carrying a JSON-Schema outputSchema", () => {
    const root: WorkflowNode = {
      type: "sequence", id: "root", children: [
        { type: "step", id: "researcher", prompt: "r", outputSchema: { type: "object", required: ["facts"] } },
        { type: "step", id: "summarizer", prompt: "s" }, // no schema
      ],
    };
    attachOutputValidators(root);
    const [researcher, summarizer] = (root as { children: WorkflowNode[] }).children;
    assert.ok(hasSafeParse(researcher), "researcher schema wrapped into a ZodLike");
    assert.equal((summarizer as { outputSchema?: unknown }).outputSchema, undefined, "no-schema step untouched");
  });

  it("leaves an already-ZodLike outputSchema (the code-DSL path) untouched", () => {
    const live = { safeParse: () => ({ success: true as const, data: 1 }) };
    const root: WorkflowNode = { type: "step", id: "s", prompt: "p", outputSchema: live };
    attachOutputValidators(root);
    assert.equal((root as { outputSchema?: unknown }).outputSchema, live);
  });
});

// End-to-end (Issues B + C + A together): a run-inline spec whose researcher
// declares a JSON-Schema outputSchema now produces the PARSED OBJECT as its step
// output, so the summarizer's {{nodes.researcher.output.facts}} resolves to the
// real array (not ""). The validator is the manager concretion; the engine is real.
describe("inline outputSchema honored through the real engine (Issue B)", () => {
  const CTX: RunContext = { runId: "run", ownerId: "orch", mode: "acceptEdits" };

  it("researcher output is the parsed object; downstream binding resolves the array", async () => {
    const spawn = spawnPort((spec): SpawnResponse =>
      spec.nodeId === "researcher"
        ? { output: { facts: ["f1", "f2"] } }
        : { output: "summarized" });

    const spec = {
      name: "research-then-summarize",
      root: {
        type: "sequence", id: "root", children: [
          { type: "step", id: "researcher", prompt: "research {{args.topic}}",
            outputSchema: { type: "object", properties: { facts: { type: "array", items: { type: "string" } } }, required: ["facts"] } },
          { type: "step", id: "summarizer", prompt: "summarize: {{nodes.researcher.output.facts}}" },
        ],
      },
    } as unknown as WorkflowDefinition;

    attachOutputValidators(spec.root); // what WorkflowService.run does at acceptance
    const { engine, deps } = buildEngine(spawn);
    const res = await engine.run(spec, { topic: "X" }, CTX);

    assert.equal(res.status, "passed");
    // typed step I/O restored: the researcher's output is the structured object
    assert.deepEqual(deps.steps.findByNode("run", "researcher")?.output, { facts: ["f1", "f2"] });
    // the downstream typed binding resolves to the real array, not ""
    const summarizer = spawn.calls.steps.find((s) => s.nodeId === "summarizer");
    assert.match(summarizer!.prompt, /\["f1","f2"\]/);
  });
});

// Phase 3: the v2-graph analog. attachGraphPortValidators compiles a `json` INPUT
// port's plain JSON-Schema into the same ZodLike the scheduler duck-types at the edge
// boundary — JSON-Schema knowledge stays manager-side, the pure core only sees
// safeParse (DIP, exactly as Part B did for the output tool arg).
describe("attachGraphPortValidators — compiles json input ports into the scheduler's ZodLike", () => {
  const hasSafeParse = (s: unknown): boolean => typeof (s as { safeParse?: unknown })?.safeParse === "function";

  it("wraps a plain JSON-Schema on a json input port (recursing loop bodies); leaves others untouched", () => {
    const body: WorkflowGraph = {
      name: "body", version: WORKFLOW_GRAPH_VERSION,
      nodes: [
        { id: "__input__", kind: "input" },
        { id: "bw", kind: "worker", inputs: [{ name: "p", type: "json", schema: { type: "object", required: ["x"] } }] },
        { id: "__output__", kind: "output" },
      ],
      edges: [],
    };
    const graph: WorkflowGraph = {
      name: "g", version: WORKFLOW_GRAPH_VERSION,
      nodes: [
        { id: "in", kind: "input" },
        { id: "w", kind: "worker", inputs: [
          { name: "typed", type: "json", schema: { type: "object", required: ["a"] } },
          { name: "loose", type: "any", schema: { type: "object" } }, // not a json port → untouched
          { name: "noschema", type: "json" },                          // json but no schema → untouched
        ] },
        { id: "L", kind: "loop", config: { loopKind: "forEach", body } },
        { id: "out", kind: "output" },
      ],
      edges: [],
    };

    attachGraphPortValidators(graph);

    const w = graph.nodes.find((n) => n.id === "w")!;
    assert.ok(hasSafeParse(w.inputs!.find((p) => p.name === "typed")!.schema), "json port schema compiled");
    assert.ok(!hasSafeParse(w.inputs!.find((p) => p.name === "loose")!.schema), "non-json port left as a plain schema");
    assert.equal(w.inputs!.find((p) => p.name === "noschema")!.schema, undefined, "json port without schema untouched");
    const bw = body.nodes.find((n) => n.id === "bw")!;
    assert.ok(hasSafeParse(bw.inputs!.find((p) => p.name === "p")!.schema), "nested loop-body json port compiled");
  });

  it("leaves an already-ZodLike port schema untouched (the code-DSL path)", () => {
    const live = { safeParse: () => ({ success: true as const, data: 1 }) };
    const graph: WorkflowGraph = {
      name: "g", version: WORKFLOW_GRAPH_VERSION,
      nodes: [
        { id: "in", kind: "input" },
        { id: "w", kind: "worker", inputs: [{ name: "p", type: "json", schema: live }] },
        { id: "out", kind: "output" },
      ],
      edges: [],
    };
    attachGraphPortValidators(graph);
    assert.equal(graph.nodes.find((n) => n.id === "w")!.inputs![0].schema, live);
  });
});

// End-to-end: a v2 graph whose consumer declares a typed `json` input port. After
// attachGraphPortValidators, the scheduler validates the delivered edge value against
// the compiled schema at the port boundary — a mis-shaped object fails the node, a
// valid one flows through.
describe("typed json input port validated at runtime through the real engine (Phase 3)", () => {
  const CTX: RunContext = { runId: "run", ownerId: "orch", mode: "acceptEdits" };

  const graph = (): WorkflowGraph => ({
    name: "typed-json-port", version: WORKFLOW_GRAPH_VERSION,
    nodes: [
      { id: "in", kind: "input" },
      { id: "producer", kind: "worker", config: { prompt: "p" }, outputs: [{ name: "out", type: "json" }] },
      { id: "consumer", kind: "worker", config: { prompt: "c {{in.payload}}" },
        inputs: [{ name: "payload", type: "json", schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } }] },
      { id: "out", kind: "output", inputs: [{ name: "in", type: "any" }] },
    ],
    edges: [
      { from: { node: "in", port: "out" }, to: { node: "producer", port: "in" } },
      { from: { node: "producer", port: "out" }, to: { node: "consumer", port: "payload" } },
      { from: { node: "consumer", port: "out" }, to: { node: "out", port: "in" } },
    ],
  });

  it("fails the consumer when the delivered object violates the port schema", async () => {
    const g = graph();
    attachGraphPortValidators(g); // what a future v2-graph acceptance path will do
    const spawn = spawnPort((spec): SpawnResponse => (spec.nodeId === "producer" ? { output: { n: "not-a-number" } } : {}));
    const { engine } = buildEngine(spawn);
    const res = await engine.run(g, {}, CTX);

    assert.equal(res.status, "failed");
    assert.match(String(res.output), /input port "payload" failed schema validation/);
    assert.ok(!spawn.calls.steps.some((s) => s.nodeId === "consumer"), "the mis-shaped node never spawned");
  });

  it("passes the consumer when the delivered object matches the port schema", async () => {
    const g = graph();
    attachGraphPortValidators(g);
    const spawn = spawnPort((spec): SpawnResponse => (spec.nodeId === "producer" ? { output: { n: 5 } } : {}));
    const { engine } = buildEngine(spawn);
    const res = await engine.run(g, {}, CTX);

    assert.equal(res.status, "passed");
    assert.ok(spawn.calls.steps.some((s) => s.nodeId === "consumer"), "the validated node ran");
  });
});
