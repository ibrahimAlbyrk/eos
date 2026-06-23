import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerWorkerRoutes } from "../workers.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";
import type { AgentBackend } from "../../../core/src/ports/AgentBackend.ts";

// Backend doubles whose descriptors carry just what canLazyResume reads
// (processModel + capabilities.resumable). claude-sdk = in-process + resumable
// (a SUSPENDED session revives in-process on demand); claude-cli = out-of-process
// (stays declined while SUSPENDED).
function backend(kind: string, processModel: "in-process" | "out-of-process", resumable: boolean): AgentBackend {
  return {
    kind,
    descriptor: { kind, processModel, capabilities: { resumable } },
    attach: () => ({}) as never,
  } as unknown as AgentBackend;
}
const BACKENDS: Record<string, AgentBackend> = {
  "claude-sdk": backend("claude-sdk", "in-process", true),
  "claude-cli": backend("claude-cli", "out-of-process", false),
};

type Row = { id: string; name?: string | null; parent_id: string | null; collaborate: number | null; state: string; backend_kind: string; session_id?: string | null };

function containerWith(rows: Row[], supervised: Set<string> = new Set()) {
  const registered: Array<{ from: string; to: string; question: string }> = [];
  const c = {
    workers: {
      findById: (id: string) => rows.find((r) => r.id === id) ?? null,
      listByParent: (pid: string) => rows.filter((r) => r.parent_id === pid),
    },
    backends: { has: (k: string) => k in BACKENDS, get: (k: string) => BACKENDS[k] },
    claudeCliBackend: BACKENDS["claude-cli"],
    supervisor: { has: (id: string) => supervised.has(id) },
    pendingPeerRequests: {
      wouldDeadlock: () => false,
      register: (from: string, to: string, question: string) => { registered.push({ from, to, question }); return { requestId: "req1" }; },
    },
    events: { append: () => 1 },
    clock: { now: () => 1 },
    bus: { publish: () => {} },
  } as unknown as Container;
  return { c, registered };
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
  return { status, payload };
}

describe("peer routes — SUSPENDED workers are consultable when their backend revives in-process", () => {
  const mesh = (): Row[] => [
    { id: "A", parent_id: "orch", collaborate: 1, state: "IDLE", backend_kind: "claude-sdk" },
    { id: "B", parent_id: "orch", collaborate: 1, state: "IDLE", backend_kind: "claude-cli" },          // live → always shown
    { id: "S", name: "sleeper", parent_id: "orch", collaborate: 1, state: "SUSPENDED", backend_kind: "claude-sdk", session_id: "sess-1" }, // SUSPENDED sdk → shown
    { id: "Z", parent_id: "orch", collaborate: 1, state: "SUSPENDED", backend_kind: "claude-cli", session_id: "sess-2" }, // SUSPENDED cli → hidden
  ];

  it("GET /peers includes a SUSPENDED claude-sdk sibling but not a SUSPENDED claude-cli one", async () => {
    const { c } = containerWith(mesh());
    const out = await dispatch(c, "GET", "/workers/A/peers");
    assert.equal(out.status, 200);
    const ids = (out.payload as Array<{ id: string }>).map((p) => p.id).sort();
    assert.deepEqual(ids, ["B", "S"]);
  });

  it("ask_peer to a SUSPENDED claude-cli peer is still declined", async () => {
    const { c, registered } = containerWith(mesh());
    const out = await dispatch(c, "POST", "/workers/A/peer-request", { target: { id: "Z" }, question: "help?" });
    assert.equal(out.status, 200);
    assert.equal((out.payload as { declined?: boolean }).declined, true);
    assert.equal(registered.length, 0);
  });

  it("ask_peer to a SUSPENDED claude-sdk peer resolves + registers (no decline)", async () => {
    // supervised so resumeIfDead is a no-op here — the resolve/register decision
    // is what this asserts; the actual revive is the shared resumeIfDead helper.
    const { c, registered } = containerWith(mesh(), new Set(["S"]));
    const out = await dispatch(c, "POST", "/workers/A/peer-request", { target: { name: "sleeper" }, question: "help?" });
    assert.equal(out.status, 200);
    assert.equal((out.payload as { requestId?: string }).requestId, "req1");
    assert.deepEqual(registered, [{ from: "A", to: "S", question: "help?" }]);
  });
});
