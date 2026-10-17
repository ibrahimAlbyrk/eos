import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router, type RouteContext } from "../Router.ts";
import { registerWorkflowRunRoutes } from "../workflow-runs.ts";
import type { Container } from "../../container.ts";
import { WorkflowRunService } from "../../services/WorkflowRunService.ts";

const UI = { "x-eos-ui-token": "tok" };
const ROOT = "/Users/u/.claude/projects";
const DIR = `${ROOT}/-p/s/subagents/workflows/wf_1`;

function makeContainer() {
  const stops: string[] = [];
  const workflowRuns = new WorkflowRunService({
    bus: { publish() {} },
    agentEvents: () => [],
    session: () => ({ isAlive: () => true, stopTask: async (id: string) => { stops.push(id); return { ok: true }; } }),
    claudeProjectsDir: ROOT,
    readFile: (p) => (p === `${DIR}/agent-a8e1f3e896e86fcec.jsonl`
      ? JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, isSidechain: true, message: { role: "user", content: "go" } })
      : null),
  });
  workflowRuns.observe("w-1", { type: "workflow_started", callId: "toolu_1", taskId: "t1", transcriptDir: DIR });
  return { c: { uiToken: "tok", workflowRuns } as unknown as Container, stops };
}

async function call(c: Container, method: string, path: string, headers: Record<string, string> = {}) {
  const router = new Router();
  registerWorkflowRunRoutes(router, c);
  const u = new URL("http://x" + path);
  const m = router.match(method, u.pathname);
  assert.ok(m, `no ${method} route matched ${u.pathname}`);
  const req = Object.assign(Readable.from(["{}"]), { headers }) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  return { status, payload: payload as Record<string, any> };
}

describe("workflow run routes", () => {
  it("lists live runs and reads one; an unknown run is 404", async () => {
    const { c } = makeContainer();
    const list = await call(c, "GET", "/workers/w-1/workflow-runs");
    assert.equal(list.status, 200);
    assert.equal(list.payload.runs[0].callId, "toolu_1");
    assert.equal((await call(c, "GET", "/workers/w-1/workflow-runs/toolu_1")).payload.status, "running");
    assert.equal((await call(c, "GET", "/workers/w-1/workflow-runs/toolu_9")).status, 404);
  });

  it("serves an agent's transcript rows; a bad agent id is 404", async () => {
    const { c } = makeContainer();
    const ok = await call(c, "GET", "/workers/w-1/workflow-runs/toolu_1/agents/a8e1f3e896e86fcec");
    assert.equal(ok.status, 200);
    assert.equal(ok.payload.rows[0].type, "user_message");
    assert.equal((await call(c, "GET", "/workers/w-1/workflow-runs/toolu_1/agents/..%2Fx")).status, 404);
  });

  it("stop needs the ui token, then stops the run's task", async () => {
    const { c, stops } = makeContainer();
    assert.equal((await call(c, "POST", "/workers/w-1/workflow-runs/toolu_1/stop")).status, 403);
    assert.equal((await call(c, "POST", "/workers/w-1/workflow-runs/toolu_1/stop", UI)).status, 200);
    assert.deepEqual(stops, ["t1"]);
    assert.equal((await call(c, "POST", "/workers/w-1/workflow-runs/toolu_9/stop", UI)).status, 404);
  });
});
