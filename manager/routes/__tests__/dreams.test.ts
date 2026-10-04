import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { Router, type RouteContext } from "../Router.ts";
import { registerDreamRoutes } from "../dreams.ts";
import type { Container } from "../../container.ts";
import { SqliteDreamRepo } from "../../../infra/src/persistence/SqliteDreamRepo.ts";
import { runMigrations } from "../../../infra/src/persistence/MigrationRunner.ts";

const noopLog = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLog; } };
const UI = { "x-eos-ui-token": "tok" };

function makeContainer() {
  const db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  const dreamRepo = new SqliteDreamRepo(db);
  let started = 0;
  let running = false;
  const dreams = {
    status: () => ({ running, runId: null, progress: null, lastRun: dreamRepo.latest(), nextAt: null, blocked: null }),
    dreamNow: () => {
      if (running) return { started: false, reason: "A dream is already running" };
      running = true;
      started++;
      return { started: true };
    },
    requestStop: () => running,
  };
  return { c: { uiToken: "tok", dreamRepo, dreams } as unknown as Container, started: () => started };
}

async function call(c: Container, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const router = new Router();
  registerDreamRoutes(router, c);
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

describe("dream routes", () => {
  it("dream now needs the ui token and refuses a second run", async () => {
    const { c, started } = makeContainer();
    assert.equal((await call(c, "POST", "/api/dreams")).status, 403);
    assert.equal((await call(c, "POST", "/api/dreams", undefined, UI)).status, 202);
    const again = await call(c, "POST", "/api/dreams", undefined, UI);
    assert.equal(again.status, 409);
    assert.equal(started(), 1);
  });

  it("status, list and one run are readable", async () => {
    const { c } = makeContainer();
    c.dreamRepo.save({
      id: "dr-abc123", trigger: "nightly", status: "done", reason: null, startedAt: 1, finishedAt: 2, model: "opus",
      chatsRead: 1, observations: 1, proposed: 1, tokens: 5, narrative: null,
      dropped: { oneOff: 0, known: 0, declined: 0, secret: 0, weak: 0, invalid: 0 }, chats: [],
    });
    assert.equal((await call(c, "GET", "/api/dreams/status")).payload.lastRun.id, "dr-abc123");
    assert.equal((await call(c, "GET", "/api/dreams")).payload.runs.length, 1);
    assert.equal((await call(c, "GET", "/api/dreams/dr-abc123")).payload.run.id, "dr-abc123");
    assert.equal((await call(c, "GET", "/api/dreams/dr-nope00")).status, 404);
  });

  it("turning a chat off is the user's", async () => {
    const { c } = makeContainer();
    assert.equal((await call(c, "POST", "/api/dreams/exclusions", { workerId: "w-1", excluded: true })).status, 403);
    const r = await call(c, "POST", "/api/dreams/exclusions", { workerId: "w-1", excluded: true }, UI);
    assert.deepEqual(r.payload.excluded, ["w-1"]);
  });
});
