import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router, type RouteContext } from "../Router.ts";
import { registerFsGitRoutes } from "../fs-git.ts";
import type { Container } from "../../container.ts";

function makeContainer(initial: string[]) {
  const recents = [...initial];
  const c = {
    uiToken: "tok",
    recents: {
      list: () => recents,
      push: () => {},
      remove: (p: string) => { const i = recents.indexOf(p); if (i >= 0) recents.splice(i, 1); },
    },
  } as unknown as Container;
  return { c, recents };
}

async function call(c: Container, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const router = new Router();
  registerFsGitRoutes(router, c);
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

describe("recents routes", () => {
  it("remove requires the ui token and an absolute path", async () => {
    const { c, recents } = makeContainer(["/a"]);
    assert.equal((await call(c, "POST", "/fs/recents/remove", { path: "/a" })).status, 403);
    assert.equal((await call(c, "POST", "/fs/recents/remove", { path: "rel" }, TOKEN)).status, 400);
    assert.deepEqual(recents, ["/a"]);
  });

  it("remove forgets only that folder", async () => {
    const { c } = makeContainer(["/a", "/b"]);
    assert.equal((await call(c, "POST", "/fs/recents/remove", { path: "/a" }, TOKEN)).status, 200);
    assert.deepEqual((await call(c, "GET", "/fs/recents")).payload.paths, ["/b"]);
  });
});
