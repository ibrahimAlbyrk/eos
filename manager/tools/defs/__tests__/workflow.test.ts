import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { workflowDef } from "../workflow.ts";
import type { ToolContext } from "../../types.ts";
import { WorkflowToolRequestSchema, WorkflowDefinitionSchema } from "../../../../contracts/src/workflow.ts";

function recording(response: unknown = {}) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx: ToolContext = {
    selfId: "orch-1",
    cwd: "/repo",
    isGitRepo: () => true,
    api: async (method, path, body) => { calls.push({ method, path, body }); return response; },
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

describe("workflow tool — pairs the structured result with a human message line", () => {
  const spec = { name: "wf", root: { id: "r", type: "step", from: "x", prompt: "p" } };

  it("run-stored keeps runId/status and frames completion-as-a-message (not poll-first)", async () => {
    const { ctx } = recording({ runId: "run-9", status: "running" });
    const res = await workflowDef.handler(ctx, { mode: "run-stored", from: "research" }) as Record<string, unknown>;
    assert.equal(res.runId, "run-9");
    assert.equal(res.status, "running");
    const message = res.message as string;
    assert.match(message, /run-9/);
    assert.match(message, /delivered to you as a message when it completes/);
    assert.match(message, /do NOT need to poll/);
    // The completion-as-a-message framing must lead; the status check is secondary.
    assert.ok(message.indexOf("delivered to you as a message") < message.indexOf("mode:'status'"));
  });

  it("run-inline carries the same completion-as-a-message line", async () => {
    const { ctx } = recording({ runId: "run-7", status: "running" });
    const res = await workflowDef.handler(ctx, { mode: "run-inline", spec }) as Record<string, unknown>;
    assert.equal(res.runId, "run-7");
    assert.match(res.message as string, /delivered to you as a message when it completes/);
  });

  it("create echoes the name and tells the orchestrator how to run it", async () => {
    const { ctx } = recording({ name: "wf" });
    const res = await workflowDef.handler(ctx, { mode: "create", spec }) as Record<string, unknown>;
    assert.equal(res.name, "wf");
    assert.match(res.message as string, /Workflow 'wf' saved\. Run it with `workflow \{mode:'run-stored', from:'wf'\}`\./);
  });

  it("status echoes the run row and adds a one-line summary", async () => {
    const { ctx } = recording({ runId: "run-9", status: "succeeded", output: { ok: true } });
    const res = await workflowDef.handler(ctx, { mode: "status", runId: "run-9" }) as Record<string, unknown>;
    assert.equal(res.runId, "run-9");
    assert.equal(res.status, "succeeded");
    assert.deepEqual(res.output, { ok: true });
    assert.equal(res.message, "Workflow run run-9 is succeeded.");
  });

  it("stop reports the run stopped and its subtree reaped", async () => {
    const { ctx } = recording({ runId: "run-9", status: "stopped" });
    const res = await workflowDef.handler(ctx, { mode: "stop", runId: "run-9" }) as Record<string, unknown>;
    assert.equal(res.runId, "run-9");
    assert.equal(res.status, "stopped");
    assert.equal(res.message, "Run run-9 stopped; its worker subtree was reaped.");
  });

  it("every mode's result carries a non-empty message line", async () => {
    const cases: Array<[string, unknown, Record<string, unknown>]> = [
      ["run-stored", { runId: "r", status: "running" }, { mode: "run-stored", from: "research" }],
      ["run-inline", { runId: "r", status: "running" }, { mode: "run-inline", spec }],
      ["create", { name: "wf" }, { mode: "create", spec }],
      ["status", { runId: "r", status: "running" }, { mode: "status", runId: "r" }],
      ["stop", { runId: "r", status: "stopped" }, { mode: "stop", runId: "r" }],
    ];
    for (const [, response, args] of cases) {
      const { ctx } = recording(response);
      const res = await workflowDef.handler(ctx, args) as Record<string, unknown>;
      assert.equal(typeof res.message, "string");
      assert.ok((res.message as string).length > 0);
    }
  });
});
