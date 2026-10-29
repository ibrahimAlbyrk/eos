import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router, type RouteContext } from "../Router.ts";
import { registerArtifactRoutes } from "../artifacts.ts";
import type { Container } from "../../container.ts";
import { ArtifactCatalogService } from "../../../core/src/services/ArtifactCatalogService.ts";
import { ROUTES } from "../../../contracts/src/http.ts";
import { isLocalOnlyRoute } from "../../../contracts/src/route-planes.ts";
import type { ArtifactCatalog } from "../../../contracts/src/artifacts.ts";

const UI = { "x-eos-ui-token": "tok" };
const SLUG = "0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

function makeContainer() {
  let reads = 0;
  const artifacts = new ArtifactCatalogService({
    source: {
      list: async (loginId) => {
        reads++;
        return [{ slug: SLUG, url: "https://claude.ai/artifact/x", title: "Plan", kind: "Page", rel: "mine", updatedAt: "2026-10-29T10:00:00Z", loginId }];
      },
    },
    logins: () => [{ id: "lg-1", label: "Personal" }],
    clock: { now: () => Date.UTC(2026, 9, 29, 12) },
    publish: () => {},
  });
  return { c: { uiToken: "tok", artifacts } as unknown as Container, reads: () => reads };
}

async function call(c: Container, method: string, path: string, headers: Record<string, string> = {}) {
  const router = new Router();
  registerArtifactRoutes(router, c);
  const u = new URL("http://x" + path);
  const m = router.match(method, u.pathname);
  assert.ok(m, `no ${method} route matched ${u.pathname}`);
  const req = Object.assign(Readable.from([]), { headers }) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    req: { headers: {} },
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url: u, req, res } as RouteContext);
  return { status, payload: payload as ArtifactCatalog };
}

describe("artifact routes", () => {
  it("are the dashboard's only, and never cross to another computer", async () => {
    const { c, reads } = makeContainer();
    assert.equal((await call(c, "GET", ROUTES.artifacts)).status, 403);
    assert.equal((await call(c, "POST", ROUTES.artifactsRefresh)).status, 403);
    assert.equal(reads(), 0);
    assert.equal(isLocalOnlyRoute("GET", ROUTES.artifacts), true);
    assert.equal(isLocalOnlyRoute("POST", ROUTES.artifactsRefresh), true);
  });

  it("GET answers from memory; POST refresh answers once the sign-ins are read", async () => {
    const { c, reads } = makeContainer();
    const first = await call(c, "GET", ROUTES.artifacts, UI);
    assert.equal(first.status, 200);
    assert.deepEqual(first.payload.artifacts, []);
    assert.equal(first.payload.refreshing, true);

    const fresh = await call(c, "POST", ROUTES.artifactsRefresh, UI);
    assert.equal(fresh.status, 200);
    assert.deepEqual(fresh.payload.artifacts.map((a) => a.slug), [SLUG]);
    assert.equal(fresh.payload.accounts[0].count, 1);
    assert.equal(fresh.payload.refreshing, false);
    assert.ok(reads() >= 1);
  });
});
