import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Router } from "../Router.ts";
import { registerWorkflowRoutes } from "../workflows.ts";
import { deleteWorkflowDefinition } from "../../../core/src/use-cases/DeleteWorkflowDefinition.ts";
import type { RuntimeWorkflowDefinitionStore } from "../../../core/src/ports/RuntimeWorkflowDefinitionStore.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import type { IncomingMessage } from "node:http";

function fakeReq(body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  return {
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === "data") cb(raw);
      if (event === "end") cb();
      return this;
    },
  } as unknown as IncomingMessage;
}

// Builtin names the route's delete path must reject (mirrors the container's
// isBuiltinDefinition). A fake runtime store backs the real delete use-case so the
// route test exercises true stored/builtin/not-found semantics, not a stub verdict.
const BUILTINS = new Set(["build-with-experts"]);

// A container whose workflowService records what the route asked of it.
function harness(enabled = true) {
  const calls = {
    run: [] as Array<{ input: unknown; owner: string }>,
    create: [] as Array<{ spec: unknown; owner: string }>,
    status: [] as string[],
    stop: [] as string[],
  };
  // Seeded under the operator owner — an owner-less DELETE resolves to "operator".
  const stored = [{ owner: "operator", name: "t4-inner-sum" }];
  const definitions: RuntimeWorkflowDefinitionStore = {
    create() {},
    listFor() { return []; },
    delete(owner: string, name: string): boolean {
      const i = stored.findIndex((r) => r.owner === owner && r.name === name);
      if (i < 0) return false;
      stored.splice(i, 1);
      return true;
    },
    deleteForOwner() {},
  };
  const runs = new Map<string, unknown>([["run-7", { id: "run-7", status: "running" }]]);
  const c = {
    config: { workflow: { enabled } },
    workflowService: {
      run: (input: unknown, owner: string) => { calls.run.push({ input, owner }); return { runId: "run-1", status: "running" }; },
      create: (spec: unknown, owner: string) => { calls.create.push({ spec, owner }); return { name: "wf" }; },
      status: (runId: string) => { calls.status.push(runId); return { runId, status: "passed" }; },
      stop: (runId: string) => { calls.stop.push(runId); return { runId, status: "stopped" }; },
      deleteDefinition: (name: string, owner: string) =>
        deleteWorkflowDefinition({ store: definitions, isBuiltin: (n) => BUILTINS.has(n) }, { ownerId: owner, name }),
    },
    workflowRuns: { findById: (id: string) => runs.get(id) ?? null },
    workflowNodeCatalog: {
      nodeKinds: [
        { kind: "input", label: "Input", category: "io", inputs: [], outputs: [{ name: "out", type: "any" }] },
        { kind: "output", label: "Output", category: "io", inputs: [{ name: "in", type: "any" }], outputs: [] },
      ],
      transformFns: ["identity", "dedup"],
    },
  } as unknown as Container;
  return { c, calls };
}

async function invoke(c: Container, method: "POST" | "PUT" | "GET" | "DELETE", path: string, body?: unknown) {
  const router = new Router();
  registerWorkflowRoutes(router, c);
  const url = new URL(`http://x${path}`);
  // match() keys on the pathname (literal "/workflows" or the :id regex); the
  // owner rides url.search, read by the handler.
  const matched = router.match(method, url.pathname);
  assert.ok(matched, `no ${method} route matched ${path}`);
  let status = 0;
  let payload: unknown;
  const res = {
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await matched.handler({
    method, path: url.pathname, url, params: matched.params,
    req: body !== undefined ? fakeReq(body) : ({} as RouteContext["req"]),
    res, requestId: "t",
  } as RouteContext);
  return { status, payload };
}

describe("workflow routes — owner-scoped, calling the service", () => {
  it("POST run-stored calls workflowService.run with the owner + args", async () => {
    const { c, calls } = harness();
    const out = await invoke(c, "POST", "/workflows?owner=orch-1", { mode: "run-stored", from: "wf", args: { x: 1 } });
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { runId: "run-1", status: "running" });
    assert.equal(calls.run.length, 1);
    assert.equal(calls.run[0].owner, "orch-1");
    assert.deepEqual(calls.run[0].input, { from: "wf", args: { x: 1 } });
  });

  it("POST stop calls workflowService.stop", async () => {
    const { c, calls } = harness();
    const out = await invoke(c, "POST", "/workflows?owner=orch-1", { mode: "stop", runId: "run-9" });
    assert.equal(out.status, 200);
    assert.deepEqual(calls.stop, ["run-9"]);
  });

  it("POST status calls workflowService.status", async () => {
    const { c, calls } = harness();
    await invoke(c, "POST", "/workflows?owner=orch-1", { mode: "status", runId: "run-9" });
    assert.deepEqual(calls.status, ["run-9"]);
  });

  it("POST without an owner defaults to the operator owner (operator-owned run, A6.4)", async () => {
    const { c, calls } = harness();
    const out = await invoke(c, "POST", "/workflows", { mode: "run-stored", from: "wf", args: { x: 1 } });
    assert.equal(out.status, 200);
    assert.equal(calls.run.length, 1);
    assert.equal(calls.run[0].owner, "operator", "owner-less POST runs as the synthetic operator");
  });

  it("POST run-inline accepts a v2 graph spec (operator file-run path)", async () => {
    const { c, calls } = harness();
    const graph = {
      name: "g", version: 2,
      nodes: [
        { id: "in", kind: "input" },
        { id: "len", kind: "transform", config: { fn: "length", over: "{{args.items}}" } },
        { id: "out", kind: "output" },
      ],
      edges: [
        { from: { node: "in" }, to: { node: "len" } },
        { from: { node: "len" }, to: { node: "out" } },
      ],
    };
    const out = await invoke(c, "POST", "/workflows", { mode: "run-inline", spec: graph, args: { items: [1, 2, 3] } });
    assert.equal(out.status, 200);
    assert.equal(calls.run.length, 1);
    assert.equal(calls.run[0].owner, "operator");
    assert.equal((calls.run[0].input as { spec?: { version?: number } }).spec?.version, 2, "the v2 graph reached the service");
  });

  it("POST run-inline rejects a structurally-invalid v2 graph at validation (→400)", async () => {
    const { c, calls } = harness();
    const badGraph = { name: "g", version: 2, nodes: [{ id: "in", kind: "input" }], edges: [] }; // no output node
    // validate() throws ValidationError, which the daemon's central error handler maps
    // to 400; the route test harness surfaces the throw directly.
    await assert.rejects(
      invoke(c, "POST", "/workflows?owner=orch-1", { mode: "run-inline", spec: badGraph }),
      /output.*node|invalid request/,
    );
    assert.equal(calls.run.length, 0, "an invalid graph never reaches the service");
  });

  it("an operator-owned run's result is read back via GET /workflows/:id", async () => {
    const { c } = harness();
    // run-stored owner-less → operator owner; the result is later read via GET, not
    // pushed into an inbox.
    await invoke(c, "POST", "/workflows", { mode: "run-stored", from: "wf" });
    const got = await invoke(c, "GET", "/workflows/run-7");
    assert.equal(got.status, 200);
    assert.deepEqual(got.payload, { id: "run-7", status: "running" });
  });

  it("POST run when the engine is disabled is 400 (status still passes through)", async () => {
    const { c, calls } = harness(false);
    const blocked = await invoke(c, "POST", "/workflows?owner=orch-1", { mode: "run-stored", from: "wf" });
    assert.equal(blocked.status, 400);
    assert.equal(calls.run.length, 0);
    const st = await invoke(c, "POST", "/workflows?owner=orch-1", { mode: "status", runId: "run-9" });
    assert.equal(st.status, 200);
  });

  it("PUT calls workflowService.create with the owner", async () => {
    const { c, calls } = harness();
    const spec = { name: "wf", root: { id: "r", type: "step", from: "x", prompt: "p" } };
    const out = await invoke(c, "PUT", "/workflows?owner=orch-2", spec);
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { name: "wf" });
    assert.equal(calls.create[0].owner, "orch-2");
  });

  it("PUT persists a v2 graph (editor SAVE path); owner-less → operator", async () => {
    const { c, calls } = harness();
    const graph = {
      name: "g", version: 2,
      nodes: [
        { id: "in", kind: "input" },
        { id: "out", kind: "output" },
      ],
      edges: [{ from: { node: "in" }, to: { node: "out" } }],
    };
    const out = await invoke(c, "PUT", "/workflows", graph);
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { name: "wf" });
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].owner, "operator", "owner-less SAVE persists under the operator owner");
    assert.equal((calls.create[0].spec as { version?: number }).version, 2, "the v2 graph reached the service");
  });

  it("PUT rejects a structurally-invalid v2 graph (→ validation throw)", async () => {
    const { c, calls } = harness();
    const badGraph = { name: "g", version: 2, nodes: [{ id: "in", kind: "input" }], edges: [] }; // no output node
    await assert.rejects(
      invoke(c, "PUT", "/workflows", badGraph),
      /output.*node|invalid request/,
    );
    assert.equal(calls.create.length, 0, "an invalid graph never reaches the service");
  });

  it("GET /workflows/catalog returns the node-kind palette (not swallowed by :id)", async () => {
    const { c } = harness();
    const out = await invoke(c, "GET", "/workflows/catalog");
    assert.equal(out.status, 200);
    const body = out.payload as { nodeKinds: Array<{ kind: string }>; transformFns: string[] };
    assert.ok(Array.isArray(body.nodeKinds), "nodeKinds is an array");
    assert.deepEqual(body.nodeKinds.map((k) => k.kind), ["input", "output"]);
    assert.deepEqual(body.transformFns, ["identity", "dedup"]);
  });

  it("GET /workflows/:id returns the run row, 404 when unknown", async () => {
    const { c } = harness();
    const ok = await invoke(c, "GET", "/workflows/run-7");
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.payload, { id: "run-7", status: "running" });
    const miss = await invoke(c, "GET", "/workflows/nope");
    assert.equal(miss.status, 404);
  });

  it("DELETE /workflows/:name removes a stored definition (owner-less → operator)", async () => {
    const { c } = harness();
    const out = await invoke(c, "DELETE", "/workflows/t4-inner-sum");
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { name: "t4-inner-sum" });
  });

  it("DELETE /workflows/:name rejects a builtin (ValidationError → 400)", async () => {
    const { c } = harness();
    // The central error handler maps ValidationError → 400; the route test harness
    // surfaces the throw directly (same pattern as the invalid-graph cases).
    await assert.rejects(
      invoke(c, "DELETE", "/workflows/build-with-experts"),
      /cannot delete builtin/,
    );
  });

  it("DELETE /workflows/:name 404s an unknown name (NotFoundError)", async () => {
    const { c } = harness();
    await assert.rejects(
      invoke(c, "DELETE", "/workflows/ghost"),
      /workflow definition not found: ghost/,
    );
  });
});
