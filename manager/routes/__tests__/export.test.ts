import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerExportRoutes } from "../export.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import type { WorkerEventRow } from "../../../contracts/src/events.ts";

function containerWith(opts: {
  workers: Record<string, { name?: string | null; is_orchestrator?: number | null; parent_id?: string | null }>;
  children: Record<string, string[]>;
  events: Record<string, WorkerEventRow[]>;
}) {
  const c = {
    workers: {
      findById: (id: string) => {
        const w = opts.workers[id];
        if (!w) return null;
        return { id, name: w.name ?? null, is_orchestrator: w.is_orchestrator ?? 0, parent_id: w.parent_id ?? null, state: "IDLE", cwd: null, worktree_from: null, branch: null, prompt: "", pid: null, port: null, started_at: 0, ended_at: null, exit_code: null };
      },
      findChildrenIds: (parentId: string) => opts.children[parentId] ?? [],
    },
    events: {
      list: (q: { workerId: string }) => opts.events[q.workerId] ?? [],
    },
  } as unknown as Container;
  return { c };
}

async function dispatch(c: Container, method: "GET", fullPath: string) {
  const router = new Router();
  registerExportRoutes(router, c);
  // Strip query string for route matching
  const pathOnly = fullPath.split("?")[0];
  const m = router.match(method, pathOnly);
  assert.ok(m, `no ${method} route matched ${pathOnly}`);
  let status = 0;
  let bodyStr = "";
  const headers: Record<string, string> = {};
  const res = {
    writeHead: (s: number, hdrs: Record<string, string>) => {
      status = s;
      Object.assign(headers, hdrs);
    },
    end: (b?: string) => { if (b) bodyStr = b; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: new URL(`http://localhost${fullPath}`), res } as RouteContext);
  return { status, body: bodyStr, headers };
}

describe("export routes", () => {
  it("export single worker → returns HTML with that worker's events", async () => {
    const { c } = containerWith({
      workers: {
        w1: { name: "test-worker", is_orchestrator: 0 },
      },
      children: {},
      events: {
        w1: [
          { id: 1, worker_id: "w1", ts: 1000, type: "user_message", payload: '{"text":"hello"}' },
          { id: 2, worker_id: "w1", ts: 2000, type: "assistant_message", payload: '{"text":"hi there"}' },
        ],
      },
    });

    const out = await dispatch(c, "GET", "/workers/w1/export?tree=false");

    assert.equal(out.status, 200);
    assert.ok(out.headers["content-disposition"]?.includes('filename="'));
    assert.equal(out.headers["content-type"], "text/html; charset=utf-8");
    // Should contain the workers and events in the data
    assert.ok(out.body.includes("test-worker"));
    assert.ok(out.body.includes("user_message"));
    assert.ok(out.body.includes("assistant_message"));
    // Should NOT have the empty placeholder
    assert.ok(!out.body.includes("<script id=\"export-data\" type=\"application/json\">{}</script>"));
    // Should have the populated data
    assert.ok(out.body.includes("exported_at"));
  });

  it("export orchestrator with tree=true → includes children's events", async () => {
    const { c } = containerWith({
      workers: {
        orch: { name: "orchestrator", is_orchestrator: 1 },
        child1: { name: "child-1", is_orchestrator: 0 },
        child2: { name: "child-2", is_orchestrator: 0 },
      },
      children: {
        orch: ["child1", "child2"],
        child1: [],
        child2: [],
      },
      events: {
        orch: [
          { id: 1, worker_id: "orch", ts: 1000, type: "user_message", payload: '{"text":"parent msg"}' },
        ],
        child1: [
          { id: 2, worker_id: "child1", ts: 2000, type: "assistant_message", payload: '{"text":"child1 reply"}' },
        ],
        child2: [
          { id: 3, worker_id: "child2", ts: 3000, type: "tool_call", payload: '{"name":"read"}' },
        ],
      },
    });

    const out = await dispatch(c, "GET", "/workers/orch/export?tree=true");

    assert.equal(out.status, 200);
    assert.ok(out.body.includes("orchestrator"));
    assert.ok(out.body.includes("child-1"));
    assert.ok(out.body.includes("child-2"));
    assert.ok(out.body.includes("parent msg"));
    assert.ok(out.body.includes("child1 reply"));
    assert.ok(out.body.includes("read"));
    // worker count in JSON data should be 3
    assert.ok(out.body.includes('"workers"'));
  });

  it("export non-existent worker → 404", async () => {
    const { c } = containerWith({
      workers: {},
      children: {},
      events: {},
    });

    const out = await dispatch(c, "GET", "/workers/ghost/export?tree=false");

    assert.equal(out.status, 404);
    assert.ok(out.body?.includes("not found"));
  });

  it("export worker with no events → still returns HTML", async () => {
    const { c } = containerWith({
      workers: {
        w1: { name: "empty-worker", is_orchestrator: 0 },
      },
      children: {},
      events: {
        w1: [],
      },
    });

    const out = await dispatch(c, "GET", "/workers/w1/export?tree=false");

    assert.equal(out.status, 200);
    assert.ok(out.body.includes("empty-worker"));
    assert.ok(out.body.includes("exported_at"));
    // Should have no events section rendered
    assert.ok(out.body.includes("script"));
  });
});
