import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerWorkerRoutes } from "../workers.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";

// The by-id and list routes are route-enriched with a server-computed context
// budget { used, limit, pct } (withContext). Occupancy comes from the row's
// last_context_tokens; the window from ModelCatalogService.contextWindowFor.

type Row = { id: string; model: string | null; last_context_tokens: number | null; parent_id: string | null; state: string; archived_at: number | null };

function containerWith(rows: Row[], window: number | null) {
  return {
    workers: {
      findById: (id: string) => rows.find((r) => r.id === id) ?? null,
      listByParent: (pid: string) => rows.filter((r) => r.parent_id === pid),
    },
    loops: { findActiveByWorker: () => null },
    backgroundActivity: { forWorker: () => [] },
    modelCatalog: { contextWindowFor: (_m: string | null) => window },
  } as unknown as Container;
}

async function dispatch(c: Container, path: string) {
  const router = new Router();
  registerWorkerRoutes(router, c);
  const url = new URL(path, "http://localhost");
  const m = router.match("GET", url.pathname);
  assert.ok(m, `no GET route matched ${url.pathname}`);
  const req = Readable.from([""]) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url, req, res, requestId: "t1", method: "GET", path: url.pathname } as RouteContext);
  return { status, payload };
}

const row = (over: Partial<Row> = {}): Row => ({
  id: "w-1", model: "sonnet-5", last_context_tokens: 500_000, parent_id: "orch", state: "IDLE", archived_at: null, ...over,
});

describe("worker routes — context enrichment", () => {
  it("by-id route carries context { used, limit, pct }", async () => {
    const c = containerWith([row()], 1_000_000);
    const out = await dispatch(c, "/workers/w-1");
    assert.equal(out.status, 200);
    assert.deepEqual((out.payload as { context: unknown }).context, { used: 500_000, limit: 1_000_000, pct: 50 });
  });

  it("null last_context_tokens reads as zero used", async () => {
    const c = containerWith([row({ last_context_tokens: null })], 1_000_000);
    const out = await dispatch(c, "/workers/w-1");
    assert.deepEqual((out.payload as { context: unknown }).context, { used: 0, limit: 1_000_000, pct: 0 });
  });

  it("unknown window → limit and pct null", async () => {
    const c = containerWith([row()], null);
    const out = await dispatch(c, "/workers/w-1");
    assert.deepEqual((out.payload as { context: unknown }).context, { used: 500_000, limit: null, pct: null });
  });

  it("list-by-parent route enriches every row", async () => {
    const c = containerWith([row(), row({ id: "w-2", last_context_tokens: 250_000 })], 1_000_000);
    const out = await dispatch(c, "/workers?parentId=orch");
    const rows = out.payload as Array<{ id: string; context: { pct: number } }>;
    assert.equal(rows.find((r) => r.id === "w-1")?.context.pct, 50);
    assert.equal(rows.find((r) => r.id === "w-2")?.context.pct, 25);
  });
});
