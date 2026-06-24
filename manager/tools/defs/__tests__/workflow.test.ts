import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { workflowDef } from "../workflow.ts";
import type { ToolContext } from "../../types.ts";
import { WorkflowToolRequestSchema, WorkflowDefinitionSchema } from "../../../../contracts/src/workflow.ts";

function recording() {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx: ToolContext = {
    selfId: "orch-1",
    cwd: "/repo",
    isGitRepo: () => true,
    api: async (method, path, body) => { calls.push({ method, path, body }); return {}; },
  };
  return { ctx, calls };
}

describe("workflow tool — posts the run/create commands owner-scoped", () => {
  it("run-stored POSTs the whole request to /workflows with the owner query", async () => {
    const { ctx, calls } = recording();
    const args = { mode: "run-stored", from: "research", args: { topic: "x" } };
    await workflowDef.handler(ctx, args);
    assert.deepEqual(calls, [{ method: "POST", path: "/workflows?owner=orch-1", body: args }]);
  });

  it("status POSTs the request (status mode) to /workflows", async () => {
    const { ctx, calls } = recording();
    const args = { mode: "status", runId: "run-9" };
    await workflowDef.handler(ctx, args);
    assert.deepEqual(calls, [{ method: "POST", path: "/workflows?owner=orch-1", body: args }]);
  });

  it("stop POSTs the request (stop mode) to /workflows", async () => {
    const { ctx, calls } = recording();
    const args = { mode: "stop", runId: "run-9" };
    await workflowDef.handler(ctx, args);
    assert.deepEqual(calls, [{ method: "POST", path: "/workflows?owner=orch-1", body: args }]);
  });

  it("create PUTs ONLY the spec to /workflows with the owner query", async () => {
    const { ctx, calls } = recording();
    const spec = { name: "wf", root: { id: "r", type: "step", from: "x", prompt: "p" } };
    await workflowDef.handler(ctx, { mode: "create", spec });
    assert.deepEqual(calls, [{ method: "PUT", path: "/workflows?owner=orch-1", body: spec }]);
  });

  it("encodes a non-trivial selfId into the owner query", async () => {
    const { ctx, calls } = recording();
    (ctx as { selfId: string }).selfId = "orch/1 a";
    await workflowDef.handler(ctx, { mode: "status", runId: "r" });
    assert.equal(calls[0].path, "/workflows?owner=orch%2F1%20a");
  });
});

describe("workflow tool — coerces stringified spec/args before posting", () => {
  const spec = { name: "wf", root: { id: "r", type: "step", from: "x", prompt: "p" } };

  it("run-inline: spec passed as a JSON STRING is posted as an object the schema accepts", async () => {
    const { ctx, calls } = recording();
    await workflowDef.handler(ctx, { mode: "run-inline", spec: JSON.stringify(spec) });
    const body = calls[0].body as { spec: unknown };
    assert.deepEqual(body.spec, spec);
    assert.doesNotThrow(() => WorkflowToolRequestSchema.parse(body));
  });

  it("run-inline: spec passed as an OBJECT validates unchanged", async () => {
    const { ctx, calls } = recording();
    await workflowDef.handler(ctx, { mode: "run-inline", spec });
    const body = calls[0].body as { spec: unknown };
    assert.deepEqual(body.spec, spec);
    assert.doesNotThrow(() => WorkflowToolRequestSchema.parse(body));
  });

  it("create: spec passed as a JSON STRING is posted as an object the schema accepts", async () => {
    const { ctx, calls } = recording();
    await workflowDef.handler(ctx, { mode: "create", spec: JSON.stringify(spec) });
    assert.deepEqual(calls[0].body, spec);
    assert.doesNotThrow(() => WorkflowDefinitionSchema.parse(calls[0].body));
  });

  it("create: spec passed as an OBJECT validates unchanged", async () => {
    const { ctx, calls } = recording();
    await workflowDef.handler(ctx, { mode: "create", spec });
    assert.deepEqual(calls[0].body, spec);
    assert.doesNotThrow(() => WorkflowDefinitionSchema.parse(calls[0].body));
  });

  it("run-inline: args passed as a JSON STRING is coerced to an object", async () => {
    const { ctx, calls } = recording();
    await workflowDef.handler(ctx, { mode: "run-inline", spec, args: JSON.stringify({ topic: "x" }) });
    const body = calls[0].body as { args: unknown };
    assert.deepEqual(body.args, { topic: "x" });
    assert.doesNotThrow(() => WorkflowToolRequestSchema.parse(body));
  });

  it("run-stored: args passed as a JSON STRING is coerced to an object", async () => {
    const { ctx, calls } = recording();
    await workflowDef.handler(ctx, { mode: "run-stored", from: "research", args: JSON.stringify({ topic: "x" }) });
    const body = calls[0].body as { args: unknown };
    assert.deepEqual(body.args, { topic: "x" });
    assert.doesNotThrow(() => WorkflowToolRequestSchema.parse(body));
  });

  it("an INVALID JSON string throws a clear error, never forwarding the string", async () => {
    const { ctx, calls } = recording();
    await assert.rejects(
      () => workflowDef.handler(ctx, { mode: "run-inline", spec: "{not json" }),
      /workflow spec must be a JSON object or a valid JSON string/,
    );
    assert.equal(calls.length, 0);
  });
});
