import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router, type RouteContext } from "../Router.ts";
import { registerProjectRoutes } from "../projects.ts";
import type { Container } from "../../container.ts";
import { JsonProjectsRepo } from "../../../infra/src/persistence/JsonProjectsRepo.ts";

function makeContainer() {
  const recents: string[] = [];
  const c = {
    uiToken: "tok",
    projects: new JsonProjectsRepo(join(mkdtempSync(join(tmpdir(), "eos-projects-")), "projects.json")),
    recents: {
      list: () => recents,
      push: (p: string) => { const i = recents.indexOf(p); if (i >= 0) recents.splice(i, 1); recents.unshift(p); },
      remove: (p: string) => { const i = recents.indexOf(p); if (i >= 0) recents.splice(i, 1); },
    },
  } as unknown as Container;
  return { c, recents };
}

async function call(c: Container, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const router = new Router();
  registerProjectRoutes(router, c);
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

const TOKEN = { "x-eos-ui-token": "tok" };

describe("project routes", () => {
  it("PUT requires the ui token and absolute folders", async () => {
    const { c } = makeContainer();
    assert.equal((await call(c, "PUT", "/projects", { name: "A", folders: ["/a"] })).status, 403);
    assert.equal((await call(c, "PUT", "/projects", { name: "A", folders: ["rel"] }, TOKEN)).status, 400);
  });

  it("PUT creates, lists, and tops recents with the primary folder", async () => {
    const { c, recents } = makeContainer();
    const r = await call(c, "PUT", "/projects", { name: "A", folders: ["/a", "/b"] }, TOKEN);
    assert.equal(r.status, 200);
    assert.equal(recents[0], "/a");
    const list = await call(c, "GET", "/projects");
    assert.deepEqual(list.payload.projects.map((p: { id: string }) => p.id), [r.payload.project.id]);
  });

  it("delete forgets the project and its folders from recents", async () => {
    const { c, recents } = makeContainer();
    const { payload } = await call(c, "PUT", "/projects", { name: "A", folders: ["/a", "/b"] }, TOKEN);
    assert.equal((await call(c, "POST", "/projects/delete", { id: payload.project.id }, TOKEN)).status, 200);
    assert.deepEqual(recents, []);
    assert.equal((await call(c, "POST", "/projects/delete", { id: payload.project.id }, TOKEN)).status, 404);
  });
});
