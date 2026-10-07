import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router, type RouteContext } from "../Router.ts";
import { registerTransferRoutes } from "../transfer.ts";
import type { Container } from "../../container.ts";
import { TransferError } from "../../../core/src/domain/transfer.ts";

const UI = { "x-eos-ui-token": "tok" };

function makeContainer() {
  const calls: Array<[string, unknown]> = [];
  const workers: Record<string, { id: string; name: string; agent_role: string | null; cwd: string; worktree_dir: null }> = {
    focus: { id: "focus", name: "Focus", agent_role: "focused", cwd: "/p", worktree_dir: null },
    child: { id: "child", name: "Child", agent_role: null, cwd: "/p", worktree_dir: null },
  };
  const c = {
    uiToken: "tok",
    workers: { findById: (id: string) => workers[id] ?? null },
    transferEndpoint: {
      home: async () => "/Users/me",
      list: async (path: string) => { calls.push(["list", path]); return { path, parent: null, home: "/Users/me", entries: [] }; },
      prepare: async () => { throw new TransferError("forbidden-dest", "not there"); },
    },
    transfers: {
      list: () => [],
      start: async (b: unknown) => { calls.push(["start", b]); return { id: "tr-00000001" }; },
      sendForAgent: async (agent: unknown, b: unknown) => { calls.push(["agent", { agent, b }]); return { id: "tr-00000002" }; },
      get: (id: string) => ({ id, origin: { kind: "agent", agentId: "focus" } }),
    },
  } as unknown as Container;
  return { c, calls };
}

async function call(c: Container, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const router = new Router();
  registerTransferRoutes(router, c);
  const u = new URL("http://x" + path);
  const m = router.match(method, u.pathname);
  assert.ok(m, `no ${method} route matched ${u.pathname}`);
  const req = Object.assign(Readable.from([JSON.stringify(body ?? {})]), { headers }) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  return { status, payload: payload as Record<string, unknown> };
}

describe("transfer routes", () => {
  it("serve this Mac's disk only to the user", async () => {
    const { c, calls } = makeContainer();
    assert.equal((await call(c, "GET", "/transfer/list?path=/Users/me/.ssh")).status, 403);
    assert.equal(calls.length, 0);
    const ok = await call(c, "GET", "/transfer/list", undefined, UI);
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, [["list", "/Users/me"]], "no path = home");
  });

  it("answer an endpoint refusal with its own code", async () => {
    const { c } = makeContainer();
    const r = await call(c, "POST", "/transfer/prepare", { id: "tr-abcdefgh", destDir: "/x", items: [{ rel: "a", type: "file", size: 1, mtimeMs: 0, mode: 420 }] }, UI);
    assert.equal(r.status, 403);
    assert.equal(r.payload.code, "forbidden-dest");
  });

  it("start a transfer only for the user", async () => {
    const { c, calls } = makeContainer();
    const body = { from: "local", to: "b".repeat(64), paths: ["/Users/me/a.zip"] };
    assert.equal((await call(c, "POST", "/api/transfers", body)).status, 403);
    assert.equal((await call(c, "POST", "/api/transfers", body, UI)).status, 201);
    assert.deepEqual(calls.map(([k]) => k), ["start"]);
  });

  it("let a focused session send — as itself, and nobody else", async () => {
    const { c, calls } = makeContainer();
    const body = { machine: "Air", paths: ["out.zip"] };
    assert.equal((await call(c, "POST", "/workers/focus/transfers", body, { "x-eos-agent-id": "focus" })).status, 201);
    assert.equal((await call(c, "POST", "/workers/child/transfers", body, { "x-eos-agent-id": "child" })).status, 403, "spawned workers can't");
    assert.equal((await call(c, "POST", "/workers/focus/transfers", body, { "x-eos-agent-id": "child" })).status, 403, "not on another's behalf");
    assert.equal((await call(c, "POST", "/workers/focus/transfers", body)).status, 403);
    assert.equal(calls.length, 1);
    assert.deepEqual((calls[0]![1] as { agent: unknown }).agent, { id: "focus", name: "Focus", cwd: "/p" });
  });

  it("let an agent follow only its own transfers", async () => {
    const { c } = makeContainer();
    assert.equal((await call(c, "GET", "/workers/focus/transfers/tr-00000002", undefined, { "x-eos-agent-id": "focus" })).status, 200);
    assert.equal((await call(c, "GET", "/workers/child/transfers/tr-00000002", undefined, { "x-eos-agent-id": "child" })).status, 403);
  });
});
