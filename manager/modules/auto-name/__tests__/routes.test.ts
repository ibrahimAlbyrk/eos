import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../../../routes/Router.ts";
import type { RouteContext } from "../../../routes/Router.ts";
import { createAutoNameModule } from "../index.ts";

function fakeModule() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const runner = {
    pause: (...args: unknown[]) => { calls.push({ fn: "pause", args }); },
    resume: (...args: unknown[]) => { calls.push({ fn: "resume", args }); },
    cancel: () => {},
  };
  const c = createAutoNameModule({
    workers: { findById: () => null, updateNameIfSource: () => false },
    events: { list: () => [] },
    bus: { publish: () => {}, subscribe: () => () => {} },
    cfg: () => ({ charLimit: 280 }),
    runner: () => runner,
  } as never);
  return { c, calls };
}

async function dispatch(c: ReturnType<typeof createAutoNameModule>, path: string, body: unknown) {
  const router = new Router();
  c.registerRoutes?.(router);
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
    const { c, calls } = fakeModule();
    const out = await dispatch(c, "/workers/w1/rename-intent", { active: true });
    assert.deepEqual(calls, [{ fn: "pause", args: ["auto-name", "w1"] }]);
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { ok: true });
  });

  it("active:false → resume('auto-name', id)", async () => {
    const { c, calls } = fakeModule();
    await dispatch(c, "/workers/w2/rename-intent", { active: false });
    assert.deepEqual(calls, [{ fn: "resume", args: ["auto-name", "w2"] }]);
  });

  it("rejects a non-boolean active (400, no pause/resume)", async () => {
    const { c, calls } = fakeModule();
    await assert.rejects(() => dispatch(c, "/workers/w3/rename-intent", { active: "yes" }));
    assert.equal(calls.length, 0);
  });
});
