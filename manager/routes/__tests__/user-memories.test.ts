import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router, type RouteContext } from "../Router.ts";
import { registerUserMemoryRoutes } from "../user-memories.ts";
import type { Container } from "../../container.ts";
import { UserMemoryService } from "../../../core/src/services/UserMemoryService.ts";
import { emptyUserProfile } from "../../../core/src/domain/user-profile.ts";
import { handleError } from "../../middleware/errorHandler.ts";
import type { UserMemory } from "../../../contracts/src/profile.ts";

// "w-root" (claude, cwd /repo) → "w-child" (worktree of /repo); "w-gem" runs on gemini.
const WORKERS: Record<string, { id: string; name: string | null; cwd: string | null; worktree_from: string | null; parent_id: string | null; backend_kind: string | null }> = {
  "w-root": { id: "w-root", name: "lead", cwd: "/repo", worktree_from: null, parent_id: null, backend_kind: "claude" },
  "w-child": { id: "w-child", name: "find-bar", cwd: null, worktree_from: "/repo", parent_id: "w-root", backend_kind: "claude" },
  "w-gem": { id: "w-gem", name: "gem", cwd: "/repo", worktree_from: null, parent_id: null, backend_kind: "gemini-cli" },
};
const UI = { "x-eos-ui-token": "tok" };
const AGENT = { "x-eos-agent-id": "w-child" };

function makeContainer() {
  const store = new Map<string, UserMemory>();
  let n = 0;
  const profile = { ...emptyUserProfile(), sharing: { withholdFrom: ["gemini-cli"] } };
  return {
    uiToken: "tok",
    workers: { findById: (id: string) => WORKERS[id] ?? null },
    profile: { get: () => profile },
    userMemories: new UserMemoryService({
      store: {
        list: () => [...store.values()],
        get: (id) => store.get(id) ?? null,
        put: (m) => { store.set(m.id, m); },
        remove: (id) => store.delete(id),
      },
      clock: { now: () => 1 },
      bus: { publish: () => {} },
      newId: () => `um-route${String(++n).padStart(4, "0")}`,
    }),
  } as unknown as Container;
}

async function call(c: Container, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const router = new Router();
  registerUserMemoryRoutes(router, c);
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
  try {
    await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  } catch (e) {
    handleError(res, e, { requestId: "t", method, path, log: { warn() {}, error() {}, info() {}, debug() {} } as never });
  }
  return { status, payload: payload as Record<string, any> };
}

const suggestion = { text: "Never restart the daemon mid-session.", category: "work-style", scope: "project", why: "said twice" };

describe("user memory routes", () => {
  it("an agent suggests; project scope resolves to its session's project", async () => {
    const c = makeContainer();
    const r = await call(c, "POST", "/api/user-memories/suggest", suggestion, AGENT);
    assert.equal(r.status, 201);
    assert.deepEqual(r.payload.memory.scope, { kind: "project", path: "/repo" });
    assert.deepEqual(r.payload.memory.source, { kind: "agent", agentId: "w-child", agentName: "find-bar", why: "said twice" });
    assert.equal(r.payload.memory.status, "suggested");
    const again = await call(c, "POST", "/api/user-memories/suggest", suggestion, AGENT);
    assert.equal(again.status, 200);
    assert.equal(again.payload.duplicate, true);
  });

  it("the UI can't suggest; a withheld provider can neither suggest nor search", async () => {
    const c = makeContainer();
    assert.equal((await call(c, "POST", "/api/user-memories/suggest", suggestion)).status, 403);
    assert.equal((await call(c, "POST", "/api/user-memories/suggest", suggestion, { "x-eos-agent-id": "w-gem" })).status, 403);
    assert.equal((await call(c, "GET", "/api/user-memories/search?q=x", undefined, { "x-eos-agent-id": "w-gem" })).status, 403);
  });

  it("only the UI token keeps, dismisses, edits or deletes", async () => {
    const c = makeContainer();
    const { payload } = await call(c, "POST", "/api/user-memories/suggest", suggestion, AGENT);
    const id = payload.memory.id;
    assert.equal((await call(c, "POST", `/api/user-memories/${id}/approve`, undefined, AGENT)).status, 403);
    const kept = await call(c, "POST", `/api/user-memories/${id}/approve`, undefined, UI);
    assert.equal(kept.payload.memory.status, "active");
    assert.equal((await call(c, "PUT", `/api/user-memories/${id}`, { tier: "on-demand" }, AGENT)).status, 403);
    const stale = await call(c, "PUT", `/api/user-memories/${id}`, { tier: "on-demand", baseRev: 0 }, UI);
    assert.equal(stale.status, 409);
    assert.equal((await call(c, "DELETE", `/api/user-memories/${id}`, undefined, UI)).status, 200);
    assert.equal((await call(c, "GET", "/api/user-memories")).payload.memories.length, 0);
  });

  it("an agent's search is scoped to its project", async () => {
    const c = makeContainer();
    await call(c, "POST", "/api/user-memories", { text: "Never restart the daemon.", category: "work-style", scope: { kind: "project", path: "/repo" } }, UI);
    await call(c, "POST", "/api/user-memories", { text: "Restart nothing in /other.", category: "work-style", scope: { kind: "project", path: "/other" } }, UI);
    const r = await call(c, "GET", "/api/user-memories/search?q=restart", undefined, AGENT);
    assert.deepEqual(r.payload.memories.map((m: UserMemory) => m.text), ["Never restart the daemon."]);
  });

  it("lists by status for the Memory view", async () => {
    const c = makeContainer();
    await call(c, "POST", "/api/user-memories/suggest", suggestion, AGENT);
    await call(c, "POST", "/api/user-memories", { text: "Call me Ibrahim.", category: "about", scope: { kind: "global" } }, UI);
    assert.equal((await call(c, "GET", "/api/user-memories?status=suggested")).payload.memories.length, 1);
    assert.equal((await call(c, "GET", "/api/user-memories")).payload.memories.length, 2);
  });
});
