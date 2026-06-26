import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { compileJsonSchema, attachOutputValidators } from "../json-schema-validator.ts";
import { buildEngine, spawnPort, jsonReport, type SpawnResponse } from "../../../core/src/__tests__/helpers/workflowFakes.ts";
import type { WorkflowNode } from "../../../contracts/src/workflow-node.ts";
import type { WorkflowDefinition } from "../../../contracts/src/workflow.ts";
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
        ? { reportText: jsonReport({ facts: ["f1", "f2"] }) }
        : { reportText: "result: summarized" });

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
