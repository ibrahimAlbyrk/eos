import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router, type RouteContext } from "../Router.ts";
import { registerPageRoutes } from "../pages.ts";
import type { Container } from "../../container.ts";
import { FilePageStore } from "../../../infra/src/persistence/FilePageStore.ts";
import { PageService } from "../../../core/src/services/PageService.ts";
import { ValidationError } from "../../../core/src/errors/index.ts";

// root "w-root" (cwd /repo) → child "w-child" (worktree, no cwd of its own).
const WORKERS: Record<string, { id: string; name: string | null; cwd: string | null; worktree_from: string | null; parent_id: string | null }> = {
  "w-root": { id: "w-root", name: "Stance IK", cwd: "/repo", worktree_from: null, parent_id: null },
  "w-child": { id: "w-child", name: "probe-bench", cwd: null, worktree_from: "/repo", parent_id: "w-root" },
};

function makeContainer() {
  const events: unknown[] = [];
  let n = 0;
  const c = {
    uiToken: "tok",
    workers: { findById: (id: string) => WORKERS[id] ?? null },
    pages: new PageService({
      store: new FilePageStore(mkdtempSync(join(tmpdir(), "eos-pages-"))),
      clock: { now: () => 1000 + n },
      bus: { publish: (_t, p) => { events.push(p); } },
      newId: () => `pg-route00${++n}`,
    }),
  } as unknown as Container;
  return { c, events };
}

async function call(c: Container, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const router = new Router();
  registerPageRoutes(router, c);
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
  return { status, payload: payload as Record<string, any> };
}

const AGENT = { "x-eos-agent-id": "w-child" };

describe("page routes", () => {
  it("an agent's page defaults to its session's project and chat", async () => {
    const { c, events } = makeContainer();
    const r = await call(c, "POST", "/api/pages", { title: "Findings", body: "x" }, AGENT);
    assert.equal(r.status, 201);
    assert.equal(r.payload.page.project, "/repo");
    assert.equal(r.payload.page.agentId, "w-root");
    assert.deepEqual(r.payload.page.updatedBy, { kind: "agent", agentId: "w-child", name: "probe-bench" });
    assert.equal(events.length, 1);
  });

  it("lists the agent's project by default, the UI everything, ?project= one project", async () => {
    const { c } = makeContainer();
    await call(c, "POST", "/api/pages", { title: "Mine" }, AGENT);
    await call(c, "POST", "/api/pages", { title: "Other", project: "/elsewhere" });
    const titles = (r: { payload: Record<string, any> }) => r.payload.pages.map((p: { title: string }) => p.title).sort();
    assert.deepEqual(titles(await call(c, "GET", "/api/pages", undefined, AGENT)), ["Mine"]);
    assert.deepEqual(titles(await call(c, "GET", "/api/pages")), ["Mine", "Other"]);
    assert.deepEqual(titles(await call(c, "GET", "/api/pages?project=/elsewhere")), ["Other"]);
    assert.deepEqual(titles(await call(c, "GET", "/api/pages?all=1", undefined, AGENT)), ["Mine", "Other"]);
  });

  it("PUT with a stale baseRev answers 409 with the current page", async () => {
    const { c } = makeContainer();
    const { payload } = await call(c, "POST", "/api/pages", { title: "T", body: "a" });
    const id = payload.page.id;
    assert.equal((await call(c, "PUT", `/api/pages/${id}`, { body: "b", baseRev: 1 })).status, 200);
    const stale = await call(c, "PUT", `/api/pages/${id}`, { body: "c", baseRev: 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.page.body, "b");
  });

  it("edit applies agent ops; a bad op is a validation error", async () => {
    const { c } = makeContainer();
    const { payload } = await call(c, "POST", "/api/pages", { title: "T", body: "- [ ] probe\n" });
    const id = payload.page.id;
    const r = await call(c, "POST", `/api/pages/${id}/edit`, { op: "setTask", task: "probe", done: true }, AGENT);
    assert.equal(r.payload.page.body, "- [x] probe\n");
    await assert.rejects(call(c, "POST", `/api/pages/${id}/edit`, { op: "replace", oldText: "nope", newText: "" }), ValidationError);
  });

  it("delete needs the ui token", async () => {
    const { c } = makeContainer();
    const { payload } = await call(c, "POST", "/api/pages", { title: "T" });
    const id = payload.page.id;
    assert.equal((await call(c, "DELETE", `/api/pages/${id}`, undefined, AGENT)).status, 403);
    assert.equal((await call(c, "DELETE", `/api/pages/${id}`, undefined, { "x-eos-ui-token": "tok" })).status, 200);
    assert.equal((await call(c, "GET", "/api/pages")).payload.pages.length, 0);
  });
});
