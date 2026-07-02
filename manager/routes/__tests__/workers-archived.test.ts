import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Router } from "../Router.ts";
import { registerWorkerRoutes } from "../workers.ts";
import { registerCommandCatalog } from "../../commands/register.ts";
import type { Container } from "../../container.ts";
import type { RouteContext } from "../Router.ts";

// ADR-3 amendment coverage: GET /workers is unconditionally active-only (no
// archived param exists), the Archive view reads the dedicated
// GET /workers/archived (which must not be shadowed by the /workers/:id detail
// pattern), and a by-id message to an archived worker is rejected 409 BEFORE
// lazy-resume can revive it.

type Row = {
  id: string; name: string | null; parent_id: string | null; state: string;
  archived_at: number | null; session_id: string | null; backend_kind: string;
  worktree_from: string | null; branch: string | null; worktree_dir: string | null;
};

function row(id: string, over: Partial<Row> = {}): Row {
  return {
    id, name: null, parent_id: null, state: "IDLE", archived_at: null,
    session_id: null, backend_kind: "claude-sdk",
    worktree_from: null, branch: null, worktree_dir: null, ...over,
  };
}

function containerWith(rows: Row[], opts: { purgeOnAppClose?: boolean } = {}) {
  const alive = new Set(rows.map((r) => r.id));
  let supervisorHasCalls = 0;
  let backendsHasCalls = 0;
  const c = {
    config: { archive: { retention: "off", purgeOnAppClose: opts.purgeOnAppClose ?? false } },
    log: { info: () => {}, warn: () => {} },
    workers: {
      findById: (id: string) => (alive.has(id) ? rows.find((r) => r.id === id) ?? null : null),
      listActive: () => rows.filter((r) => alive.has(r.id) && r.archived_at == null),
      listArchived: () => rows.filter((r) => alive.has(r.id) && r.archived_at != null),
      listByParent: (pid: string) => rows.filter((r) => alive.has(r.id) && r.parent_id === pid),
      findChildrenIds: (pid: string) => rows.filter((r) => alive.has(r.id) && r.parent_id === pid).map((r) => r.id),
      delete: (id: string) => { alive.delete(id); },
    },
    loops: { findActiveByWorker: () => null, deleteByWorker: () => {} },
    backgroundActivity: { forWorker: () => [] },
    // Observability hook: resumeIfDead's first container touch is
    // supervisor.has — zero calls proves the 409 fired before lazy-resume.
    supervisor: { has: (_id: string) => { supervisorHasCalls++; return false; } },
    // Same idea for the direct resume route: resumeWorkerVia's first
    // unconditional container touch is backends.has (modeResolver only feeds
    // the spec build that precedes it).
    modeResolver: { resolveFor: () => "default" },
    backends: { has: (_kind: string) => { backendsHasCalls++; return false; } },
    events: { deleteByWorker: () => {} },
    pending: { deleteByWorker: () => {} },
    messageQueue: { deleteByWorker: () => {} },
    deleteConversation: () => {},
    cleanupMcpConfig: () => {},
    worktreeRemovals: { enqueue: () => {} },
    bus: { publish: () => {} },
    clock: { now: () => 1 },
  } as unknown as Container;
  return {
    c,
    get supervisorHasCalls() { return supervisorHasCalls; },
    get backendsHasCalls() { return backendsHasCalls; },
  };
}

async function dispatch(c: Container, method: "GET" | "POST" | "DELETE", pathWithQuery: string, body?: unknown, opts?: { catalog?: boolean }) {
  const router = new Router();
  if (opts?.catalog) registerCommandCatalog(router, c);
  registerWorkerRoutes(router, c);
  const url = new URL(pathWithQuery, "http://localhost");
  const m = router.match(method, url.pathname);
  assert.ok(m, `no ${method} route matched ${url.pathname}`);
  const req = Readable.from([body === undefined ? "" : JSON.stringify(body)]) as unknown as RouteContext["req"];
  let status = 0;
  let payload: unknown;
  const res = {
    writeHead: (s: number) => { status = s; },
    end: (b?: string) => { payload = b ? JSON.parse(b) : undefined; },
  } as unknown as RouteContext["res"];
  await m.handler({ params: m.params, url, req, res, requestId: "t1", method, path: url.pathname } as RouteContext);
  return { status, payload };
}

const FIXTURE = (): Row[] => [
  row("w-live", { parent_id: "orch" }),
  row("w-arch", { name: "sleeper", parent_id: "orch", state: "SUSPENDED", archived_at: 5000, session_id: "sess-1" }),
  row("orch"),
];

describe("GET /workers — unconditionally active-only", () => {
  it("excludes archived rows from the plain listing", async () => {
    const { c } = containerWith(FIXTURE());
    const out = await dispatch(c, "GET", "/workers");
    assert.equal(out.status, 200);
    assert.deepEqual((out.payload as Row[]).map((w) => w.id), ["w-live", "orch"]);
  });

  it("ignores an archived query param — there is no opt-in", async () => {
    const { c } = containerWith(FIXTURE());
    const out = await dispatch(c, "GET", "/workers?archived=1");
    assert.deepEqual((out.payload as Row[]).map((w) => w.id), ["w-live", "orch"]);
  });

  it("parentId branch filters archived children the same way", async () => {
    const { c } = containerWith(FIXTURE());
    const out = await dispatch(c, "GET", "/workers?parentId=orch");
    assert.deepEqual((out.payload as Row[]).map((w) => w.id), ["w-live"]);
  });
});

describe("GET /workers/archived — dedicated dashboard listing", () => {
  it("returns only archived rows and is not shadowed by the /workers/:id detail route", async () => {
    const { c } = containerWith(FIXTURE());
    const out = await dispatch(c, "GET", "/workers/archived");
    assert.equal(out.status, 200, "literal segment must not be parsed as a worker id (404)");
    assert.deepEqual((out.payload as Row[]).map((w) => w.id), ["w-arch"]);
  });
});

describe("GET /workers/:id — agent-plane reads never see archived rows", () => {
  it("actorId present (get_worker MCP) + archived → 404, as if the row were gone", async () => {
    const { c } = containerWith(FIXTURE());
    const out = await dispatch(c, "GET", "/workers/w-arch?actorId=orch");
    assert.equal(out.status, 404);
  });

  it("dashboard read (no actorId) still sees archived detail", async () => {
    const { c } = containerWith(FIXTURE());
    const out = await dispatch(c, "GET", "/workers/w-arch");
    assert.equal(out.status, 200);
    assert.equal((out.payload as Row).id, "w-arch");
  });
});

describe("POST /workers/:id/message — archived target", () => {
  it("409 before resumeIfDead — lazy-resume can't revive a hidden worker", async () => {
    const h = containerWith(FIXTURE());
    const out = await dispatch(h.c, "POST", "/workers/w-arch/message", { text: "hello" });
    assert.equal(out.status, 409);
    assert.match((out.payload as { error: string }).error, /archived/);
    assert.equal(h.supervisorHasCalls, 0, "resumeIfDead never reached");
  });
});

describe("POST /workers/:id/resume — archived target", () => {
  it("409 before resumeWorkerVia — a direct resume can't revive an archived worker", async () => {
    const h = containerWith(FIXTURE());
    const out = await dispatch(h.c, "POST", "/workers/w-arch/resume");
    assert.equal(out.status, 409);
    assert.match((out.payload as { error: string }).error, /archived/);
    assert.equal(h.backendsHasCalls, 0, "resumeWorkerVia never reached");
  });

  it("non-archived rows still reach the resume machinery", async () => {
    const h = containerWith(FIXTURE());
    // The fake container has no resume machinery past backends.has — reaching
    // it (and blowing up there) proves the guard let the live row through.
    await assert.rejects(() => dispatch(h.c, "POST", "/workers/w-live/resume"));
    assert.equal(h.backendsHasCalls, 1);
  });
});

describe("POST /workers/archived/app-closed — purge-on-app-close hook", () => {
  it("flag off (default) → no-op: nothing purged, archived rows survive", async () => {
    const { c } = containerWith(FIXTURE());
    const out = await dispatch(c, "POST", "/workers/archived/app-closed");
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, { ok: true, purged: [] });
    const listed = await dispatch(c, "GET", "/workers/archived");
    assert.deepEqual((listed.payload as Row[]).map((w) => w.id), ["w-arch"]);
  });

  it("flag on → purges every archived root (subtree included), leaves live rows", async () => {
    const rows = [
      ...FIXTURE(),
      row("arch-root", { archived_at: 4000 }),
      row("arch-child", { parent_id: "arch-root", archived_at: 4000 }),
    ];
    const { c } = containerWith(rows, { purgeOnAppClose: true });
    const out = await dispatch(c, "POST", "/workers/archived/app-closed");
    assert.equal(out.status, 200);
    // Roots only in the response — arch-child went with its root's cascade.
    assert.deepEqual((out.payload as { purged: string[] }).purged.sort(), ["arch-root", "w-arch"]);
    const archived = await dispatch(c, "GET", "/workers/archived");
    assert.deepEqual(archived.payload, []);
    const live = await dispatch(c, "GET", "/workers");
    assert.deepEqual((live.payload as Row[]).map((w) => w.id), ["w-live", "orch"]);
  });

  it("is idempotent: a second post finds nothing archived", async () => {
    const { c } = containerWith(FIXTURE(), { purgeOnAppClose: true });
    assert.deepEqual((await dispatch(c, "POST", "/workers/archived/app-closed")).payload, { ok: true, purged: ["w-arch"] });
    assert.deepEqual((await dispatch(c, "POST", "/workers/archived/app-closed")).payload, { ok: true, purged: [] });
  });
});

describe("DELETE /workers/:id/purge — command catalog routing", () => {
  it("is not shadowed by worker.kill's /workers/:id pattern", async () => {
    const { c } = containerWith(FIXTURE());
    const out = await dispatch(c, "DELETE", "/workers/w-arch/purge", undefined, { catalog: true });
    assert.equal(out.status, 200);
    // A kill match would return {killed, removed, was_state, …}; purge's shape
    // proves the purge handler answered.
    assert.deepEqual(out.payload, { id: "w-arch", removed: true, name: "sleeper" });
  });
});
