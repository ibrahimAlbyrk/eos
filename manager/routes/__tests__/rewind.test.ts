import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerWorkerRoutes } from "../workers.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import type { AgentBackend, AgentSession } from "../../../core/src/ports/AgentBackend.ts";

// A minimal AgentBackend double: its descriptor carries the chosen `rewind` cap
// + processModel (decides the handle shape the route builds), and its attached
// session records getRewindTargets/rewind calls. `hasMethods:false` models a
// capable-by-cap-but-method-less session (defensive route branch).
function fakeBackend(opts: {
  kind: string;
  rewind: boolean;
  processModel?: "in-process" | "out-of-process";
  alive?: boolean;
  targets?: unknown[];
  rewindResult?: { ok: boolean; uuid?: string; text?: string; display?: string; index?: number; error?: string };
  hasMethods?: boolean;
}): { backend: AgentBackend; calls: { getTargets: number; rewind: Array<{ uuid: string; mode: string }> } } {
  const calls = { getTargets: 0, rewind: [] as Array<{ uuid: string; mode: string }> };
  const methods = opts.hasMethods === false ? {} : {
    getRewindTargets: async () => { calls.getTargets++; return { targets: opts.targets ?? [] }; },
    rewind: async (uuid: string, mode: string) => {
      calls.rewind.push({ uuid, mode });
      return opts.rewindResult ?? { ok: true, uuid, text: "hello", display: "hello", index: 0 };
    },
  };
  const session = {
    isAlive: () => opts.alive ?? true,
    ...methods,
  } as unknown as AgentSession;
  const backend = {
    kind: opts.kind,
    descriptor: {
      kind: opts.kind,
      processModel: opts.processModel ?? "out-of-process",
      capabilities: { rewind: opts.rewind },
    },
    attach: () => session,
  } as unknown as AgentBackend;
  return { backend, calls };
}

function containerWith(row: Record<string, unknown> | null, backend?: AgentBackend) {
  const events: Array<{ type: string; payload: unknown }> = [];
  const c = {
    workers: { findById: (id: string) => (row ? { id, ...row } : null) },
    backends: { has: () => !!backend, get: () => backend! },
    claudeCliBackend: backend,
    events: { append: (_w: string, _ts: number, type: string, payload: unknown) => { events.push({ type, payload }); return 1; } },
    clock: { now: () => 123 },
    bus: { publish: () => {} },
  } as unknown as Container;
  return { c, events };
}

async function dispatch(c: Container, method: "GET" | "POST", path: string, body?: unknown) {
  const router = new Router();
  registerWorkerRoutes(router, c);
  const m = router.match(method, path);
  assert.ok(m, `no ${method} route matched ${path}`);
  const req = Readable.from([body === undefined ? "" : JSON.stringify(body)]) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, req, res } as RouteContext);
  return { status, payload: payload as Record<string, unknown> | undefined };
}

describe("rewind routes — capability-gated (DIP)", () => {
  it("SDK worker (caps.rewind=false): GET /rewind-targets → 200 {targets:[]}, NOT 404", async () => {
    const { backend } = fakeBackend({ kind: "claude-sdk", rewind: false, processModel: "in-process" });
    const { c } = containerWith({ backend_kind: "claude-sdk", port: 0, pid: null }, backend);
    const out = await dispatch(c, "GET", "/workers/w1/rewind-targets");
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { targets: [] });
  });

  it("SDK worker (caps.rewind=false): POST /rewind → 409 unsupported, no event", async () => {
    const { backend, calls } = fakeBackend({ kind: "claude-sdk", rewind: false, processModel: "in-process" });
    const { c, events } = containerWith({ backend_kind: "claude-sdk", port: 0, pid: null }, backend);
    const out = await dispatch(c, "POST", "/workers/w1/rewind", { uuid: "u1", mode: "conversation" });
    assert.equal(out.status, 409);
    assert.equal(out.payload?.ok, false);
    assert.match(String(out.payload?.error), /not supported/);
    assert.equal(calls.rewind.length, 0);
    assert.equal(events.length, 0);
  });

  it("CLI worker (caps.rewind=true): GET /rewind-targets returns the session's targets", async () => {
    const targets = [{ uuid: "u1", text: "hi", display: "hi", upCount: 1 }];
    const { backend, calls } = fakeBackend({ kind: "claude-cli", rewind: true, targets });
    const { c } = containerWith({ backend_kind: "claude-cli", port: 4321, pid: 99 }, backend);
    const out = await dispatch(c, "GET", "/workers/w2/rewind-targets");
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { targets });
    assert.equal(calls.getTargets, 1);
  });

  it("CLI worker (caps.rewind=true): POST /rewind delegates + appends conversation_rewound", async () => {
    const { backend, calls } = fakeBackend({
      kind: "claude-cli", rewind: true,
      rewindResult: { ok: true, uuid: "u1", text: "hi", display: "hi", index: 2 },
    });
    const { c, events } = containerWith({ backend_kind: "claude-cli", port: 4321, pid: 99 }, backend);
    const out = await dispatch(c, "POST", "/workers/w2/rewind", { uuid: "u1", mode: "both" });
    assert.equal(out.status, 200);
    assert.equal(out.payload?.ok, true);
    assert.deepEqual(calls.rewind, [{ uuid: "u1", mode: "both" }]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "conversation_rewound");
    assert.deepEqual(events[0].payload, { uuid: "u1", text: "hi", display: "hi", index: 2, mode: "both" });
  });

  it("CLI worker not running: GET /rewind-targets → 409 worker not running", async () => {
    const { backend } = fakeBackend({ kind: "claude-cli", rewind: true, alive: false });
    const { c } = containerWith({ backend_kind: "claude-cli", port: 4321, pid: 99 }, backend);
    const out = await dispatch(c, "GET", "/workers/w3/rewind-targets");
    assert.equal(out.status, 409);
    assert.match(String(out.payload?.error), /not running/);
  });

  it("missing worker: GET /rewind-targets → 404", async () => {
    const { c } = containerWith(null);
    const out = await dispatch(c, "GET", "/workers/ghost/rewind-targets");
    assert.equal(out.status, 404);
  });
});
