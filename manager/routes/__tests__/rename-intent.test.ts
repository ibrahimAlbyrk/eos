import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerWorkerRoutes } from "../workers.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";

function fakeContainer() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const microTasks = {
    pause: (...args: unknown[]) => calls.push({ fn: "pause", args }),
    resume: (...args: unknown[]) => calls.push({ fn: "resume", args }),
    cancel: () => {},
    start: () => {},
  };
  const c = { microTasks } as unknown as Container;
  return { c, calls };
}

async function dispatch(c: Container, path: string, body: unknown) {
  const router = new Router();
  registerWorkerRoutes(router, c);
  const m = router.match("PUT", path);
  assert.ok(m, `no PUT route matched ${path}`);
  const req = Readable.from([JSON.stringify(body)]) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, req, res } as RouteContext);
  return { status, payload };
}

describe("PUT /workers/:id/rename-intent", () => {
  it("active:true → pause('auto-name', id)", async () => {
    const { c, calls } = fakeContainer();
    const out = await dispatch(c, "/workers/w1/rename-intent", { active: true });
    assert.deepEqual(calls, [{ fn: "pause", args: ["auto-name", "w1"] }]);
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { ok: true });
  });

  it("active:false → resume('auto-name', id)", async () => {
    const { c, calls } = fakeContainer();
    await dispatch(c, "/workers/w2/rename-intent", { active: false });
    assert.deepEqual(calls, [{ fn: "resume", args: ["auto-name", "w2"] }]);
  });

  it("rejects a non-boolean active (400, no pause/resume)", async () => {
    const { c, calls } = fakeContainer();
    await assert.rejects(() => dispatch(c, "/workers/w3/rename-intent", { active: "yes" }));
    assert.equal(calls.length, 0);
  });
});
