import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Router } from "../Router.ts";
import { registerWorkflowRoutes } from "../workflows.ts";
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

// A container whose workflowService records what the route asked of it.
function harness(enabled = true) {
  const calls = {
    run: [] as Array<{ input: unknown; owner: string }>,
    create: [] as Array<{ spec: unknown; owner: string }>,
    status: [] as string[],
    stop: [] as string[],
  };
  const runs = new Map<string, unknown>([["run-7", { id: "run-7", status: "running" }]]);
  const c = {
    config: { workflow: { enabled } },
    workflowService: {
      run: (input: unknown, owner: string) => { calls.run.push({ input, owner }); return { runId: "run-1", status: "running" }; },
      create: (spec: unknown, owner: string) => { calls.create.push({ spec, owner }); return { name: "wf" }; },
      status: (runId: string) => { calls.status.push(runId); return { runId, status: "passed" }; },
      stop: (runId: string) => { calls.stop.push(runId); return { runId, status: "stopped" }; },
    },
    workflowRuns: { findById: (id: string) => runs.get(id) ?? null },
  } as unknown as Container;
  return { c, calls };
}

async function invoke(c: Container, method: "POST" | "PUT" | "GET", path: string, body?: unknown) {
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

  it("POST without an owner is 400", async () => {
    const { c } = harness();
    const out = await invoke(c, "POST", "/workflows", { mode: "status", runId: "r" });
    assert.equal(out.status, 400);
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

  it("GET /workflows/:id returns the run row, 404 when unknown", async () => {
    const { c } = harness();
    const ok = await invoke(c, "GET", "/workflows/run-7");
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.payload, { id: "run-7", status: "running" });
    const miss = await invoke(c, "GET", "/workflows/nope");
    assert.equal(miss.status, 404);
  });
});
