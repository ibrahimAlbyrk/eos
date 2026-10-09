import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";

import { Router, type RouteContext } from "../Router.ts";
import { registerGenuiRoutes } from "../genui.ts";
import type { Container } from "../../container.ts";
import { handleError } from "../../middleware/errorHandler.ts";
import { runMigrations } from "../../../infra/src/persistence/MigrationRunner.ts";
import { SqliteGenuiViewRepo } from "../../../infra/src/persistence/SqliteGenuiViewRepo.ts";
import { GENUI_APPS_OFF_TEXT, type GenuiSwitches, type PresentViewDeps } from "../../../core/src/use-cases/PresentView.ts";
import { VIEW_ID_RE, validateView } from "../../../contracts/src/genui/catalog.ts";
import { GENUI_OFF_TEXT, newViewId, validateApp } from "../../../contracts/src/genui/spec.ts";
import { ROUTES } from "../../../contracts/src/http.ts";

const UI = { "x-eos-ui-token": "tok" };
const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../contracts/src/__tests__/fixtures/genui/${name}.json`, import.meta.url), "utf8"));
const as = (id: string) => ({ "x-eos-agent-id": id });

const SMALL = {
  title: "Two places",
  data: { places: [{ id: 1, type: "Place", name: "Çiya" }, { id: 2, type: "Place", name: "Datlı Maya" }] },
  ui: '<List of="places"/>',
  summary: "Çiya and Datlı Maya.",
};

function makeContainer(switches: GenuiSwitches = { level: "balanced", apps: true }) {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog);
  const repo = new SqliteGenuiViewRepo(db);
  const published: Array<{ topic: string; payload: unknown }> = [];
  const workers: Record<string, { id: string; name: string; is_orchestrator: number; agent_role: string | null; cwd: string; worktree_dir: null; parent_id: string | null }> = {
    orch: { id: "orch", name: "Orch", is_orchestrator: 1, agent_role: null, cwd: "/p", worktree_dir: null, parent_id: null },
    focus: { id: "focus", name: "Focus", is_orchestrator: 0, agent_role: "focused", cwd: "/p", worktree_dir: null, parent_id: null },
    child: { id: "child", name: "Child", is_orchestrator: 0, agent_role: null, cwd: "/p", worktree_dir: null, parent_id: "orch" },
  };
  const genuiPresent: PresentViewDeps = {
    views: repo,
    clock: { now: () => 5000 },
    newId: () => newViewId(),
    validateView,
    validateApp,
    settings: () => switches,
  };
  const c = {
    uiToken: "tok",
    clock: { now: () => 9000 },
    bus: { publish: (topic: string, payload: unknown) => { published.push({ topic, payload }); } },
    workers: { findById: (id: string) => workers[id] ?? null },
    genuiViews: repo,
    genuiPresent,
  } as unknown as Container;
  return { c, repo, published, switches };
}

async function call(c: Container, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const router = new Router();
  registerGenuiRoutes(router, c);
  const u = new URL("http://x" + path);
  const m = router.match(method, u.pathname);
  assert.ok(m, `no ${method} route matched ${u.pathname}`);
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), { headers }) as unknown as RouteContext["req"];
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
    handleError(res, e, { requestId: "r", method, path, log: noopLog });
  }
  return { status, payload: payload as Record<string, any> };
}

describe("POST /api/genui/views", () => {
  it("stores a view for an orchestrator and a focused session", async () => {
    const { c, repo } = makeContainer();
    for (const who of ["orch", "focus"]) {
      const r = await call(c, "POST", ROUTES.genuiViews, { input: fixture("restaurants") }, as(who));
      assert.equal(r.status, 201, who);
      assert.match(r.payload.viewId, VIEW_ID_RE);
      assert.deepEqual(r.payload.warnings, []);
      assert.equal(r.payload.stats.maps, 1);
      assert.equal(repo.get(r.payload.viewId)?.workerId, who);
    }
  });

  it("refuses spawned workers, unknown agents and the bare dashboard", async () => {
    const { c } = makeContainer();
    for (const headers of [as("child"), as("ghost"), {}, UI]) {
      const r = await call(c, "POST", ROUTES.genuiViews, { input: SMALL }, headers);
      assert.equal(r.status, 403, JSON.stringify(headers));
      assert.match(r.payload.error, /orchestrator or a focused session/);
    }
  });

  it("answers an invalid spec with 400, the formatted text and every problem", async () => {
    const { c } = makeContainer();
    const bad = { ...SMALL, tone: "pink", data: { places: [{ id: 1, type: "Place", name: "X", rating: 6.2 }] } };
    const r = await call(c, "POST", ROUTES.genuiViews, { input: bad }, as("orch"));
    assert.equal(r.status, 400);
    assert.deepEqual(Object.keys(r.payload).sort(), ["error", "problems"]);
    assert.match(r.payload.error, /^2 problems — nothing rendered\n/);
    assert.match(r.payload.error, /· data\.places\[0\]\.rating: 6\.2 is outside 0–5/);
    assert.match(r.payload.error, /fix and call present again$/);
    assert.deepEqual(r.payload.problems.map((p: { path: string }) => p.path).sort(), ["data.places[0].rating", "tone"]);
  });

  it("says visual answers are off when the level is text", async () => {
    const { c } = makeContainer({ level: "text", apps: true });
    const r = await call(c, "POST", ROUTES.genuiViews, { input: SMALL }, as("orch"));
    assert.equal(r.status, 403);
    assert.equal(r.payload.error, GENUI_OFF_TEXT);
  });
});

describe("POST /api/genui/apps", () => {
  it("stores an app, and refuses it while apps are off", async () => {
    const on = makeContainer();
    const r = await call(on.c, "POST", ROUTES.genuiApps, { input: fixture("app") }, as("focus"));
    assert.equal(r.status, 201);
    assert.equal(on.repo.get(r.payload.viewId)?.kind, "app");
    assert.equal((await call(on.c, "POST", ROUTES.genuiApps, { input: fixture("app") }, as("child"))).status, 403);

    const off = makeContainer({ level: "balanced", apps: false });
    const refused = await call(off.c, "POST", ROUTES.genuiApps, { input: fixture("app") }, as("orch"));
    assert.equal(refused.status, 403);
    assert.equal(refused.payload.error, GENUI_APPS_OFF_TEXT);
  });

  it("answers a bad document with its problems", async () => {
    const { c } = makeContainer();
    const r = await call(c, "POST", ROUTES.genuiApps, { input: { title: "x", summary: "s", html: "no tags", height: 9000 } }, as("orch"));
    assert.equal(r.status, 400);
    assert.deepEqual(r.payload.problems.map((p: { path: string }) => p.path).sort(), ["height", "html"]);
  });
});

describe("GET /api/genui/views/:id", () => {
  it("returns the stored record, 404 otherwise", async () => {
    const { c } = makeContainer();
    const { payload } = await call(c, "POST", ROUTES.genuiViews, { input: SMALL }, as("orch"));
    const r = await call(c, "GET", ROUTES.genuiView(payload.viewId));
    assert.equal(r.status, 200);
    assert.equal(r.payload.id, payload.viewId);
    assert.equal(r.payload.kind, "view");
    assert.equal(r.payload.createdAt, 5000);
    assert.deepEqual(r.payload.spec, SMALL);
    assert.equal((await call(c, "GET", ROUTES.genuiView("v_000000000000"))).status, 404);
  });
});

describe("/api/genui/views/:id/state", () => {
  it("starts empty, takes the dashboard's writes and fans them out", async () => {
    const { c, published } = makeContainer();
    const { payload } = await call(c, "POST", ROUTES.genuiViews, { input: SMALL }, as("orch"));
    const id = payload.viewId as string;
    assert.deepEqual((await call(c, "GET", ROUTES.genuiViewState(id))).payload, { viewId: id, state: {}, updatedAt: null });

    const put = await call(c, "PUT", ROUTES.genuiViewState(id), { state: { day: 2 } }, UI);
    assert.equal(put.status, 200);
    assert.deepEqual(put.payload, { viewId: id, state: { day: 2 }, updatedAt: 9000 });
    assert.deepEqual(published, [{ topic: "genui:change", payload: { viewId: id, state: { day: 2 } } }]);
    assert.deepEqual((await call(c, "GET", ROUTES.genuiViewState(id))).payload, { viewId: id, state: { day: 2 }, updatedAt: 9000 });
  });

  it("needs the ui-token to write — an agent can't set what the user picked", async () => {
    const { c, published } = makeContainer();
    const { payload } = await call(c, "POST", ROUTES.genuiViews, { input: SMALL }, as("orch"));
    const r = await call(c, "PUT", ROUTES.genuiViewState(payload.viewId), { state: { day: 2 } }, as("orch"));
    assert.equal(r.status, 403);
    assert.equal(published.length, 0);
  });

  it("refuses state over 32 KB and unknown views", async () => {
    const { c } = makeContainer();
    const { payload } = await call(c, "POST", ROUTES.genuiViews, { input: SMALL }, as("orch"));
    const big = await call(c, "PUT", ROUTES.genuiViewState(payload.viewId), { state: { blob: "x".repeat(33 * 1024) } }, UI);
    assert.equal(big.status, 400);
    assert.match(big.payload.error, /larger than 32 KB/);
    const huge = await call(c, "PUT", ROUTES.genuiViewState(payload.viewId), { state: { blob: "x".repeat(64 * 1024) } }, UI);
    assert.equal(huge.status, 413, "the body is cut off before it is buffered whole");
    assert.equal((await call(c, "PUT", ROUTES.genuiViewState("v_000000000000"), { state: {} }, UI)).status, 404);
    assert.equal((await call(c, "GET", ROUTES.genuiViewState("v_000000000000"))).status, 404);
  });
});
