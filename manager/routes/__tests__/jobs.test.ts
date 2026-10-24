import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router, type RouteContext } from "../Router.ts";
import { registerJobRoutes } from "../jobs.ts";
import type { Container } from "../../container.ts";
import { BackgroundJobService } from "../../services/BackgroundJobService.ts";
import { ROUTES } from "../../../contracts/src/http.ts";

const UI = { "x-eos-ui-token": "tok" };

function makeContainer() {
  const kills: string[] = [];
  const backgroundJobs = new BackgroundJobService({
    bus: { publish() {} },
    session: () => null,
    cancelTransfer: () => {},
    stopDream: () => false,
    killTerminal: (runId) => { kills.push(runId); return true; },
    machineName: () => "M",
    throttleMs: 0,
  });
  backgroundJobs.onTerminalStart({ workerId: "w-1", runId: "r1", command: "make", startedAt: 1 });
  backgroundJobs.onTerminalChunk({ runId: "r1", data: "built\n" });
  return { c: { uiToken: "tok", backgroundJobs } as unknown as Container, kills };
}

async function call(c: Container, method: string, path: string, headers: Record<string, string> = {}) {
  const router = new Router();
  registerJobRoutes(router, c);
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

const ID = "shell:w-1:run-r1";

describe("job routes", () => {
  it("are the dashboard's only", async () => {
    const { c } = makeContainer();
    assert.equal((await call(c, "GET", ROUTES.jobs)).status, 403);
    assert.equal((await call(c, "GET", ROUTES.jobOutput(ID))).status, 403);
    assert.equal((await call(c, "POST", ROUTES.jobStop(ID))).status, 403);
  });

  it("lists jobs and reads a job's output from an offset; an unknown job is 404", async () => {
    const { c } = makeContainer();
    const list = await call(c, "GET", ROUTES.jobs, UI);
    assert.equal(list.payload.jobs[0].id, ID);
    const out = await call(c, "GET", `${ROUTES.jobOutput(ID)}?since=0`, UI);
    assert.deepEqual(out.payload, { text: "built\n", next: 6, truncated: false, reset: false });
    assert.equal((await call(c, "GET", `${ROUTES.jobOutput(ID)}?since=6`, UI)).payload.text, "");
    assert.equal((await call(c, "GET", ROUTES.jobOutput("shell:w-1:nope"), UI)).status, 404);
  });

  it("stops a running job, and dismisses only a finished one", async () => {
    const { c, kills } = makeContainer();
    assert.equal((await call(c, "POST", ROUTES.jobDismiss(ID), UI)).status, 404);
    assert.equal((await call(c, "POST", ROUTES.jobStop(ID), UI)).status, 200);
    assert.deepEqual(kills, ["r1"]);
    c.backgroundJobs.onTerminalDone({ runId: "r1", exitCode: 0, note: null });
    assert.equal((await call(c, "POST", ROUTES.jobDismiss(ID), UI)).status, 200);
    assert.deepEqual((await call(c, "GET", ROUTES.jobs, UI)).payload.jobs, []);
  });
});
