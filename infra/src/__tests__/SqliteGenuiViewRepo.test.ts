import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SqliteGenuiViewRepo } from "../persistence/SqliteGenuiViewRepo.ts";
import { MIGRATIONS, runMigrations } from "../persistence/MigrationRunner.ts";
import { presentApp, presentView, type PresentViewDeps } from "../../../core/src/use-cases/PresentView.ts";
import { validateView } from "../../../contracts/src/genui/catalog.ts";
import { newViewId, validateApp, type ViewRecord } from "../../../contracts/src/genui/spec.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../../contracts/src/__tests__/fixtures/genui/${name}.json`, import.meta.url), "utf8"));

const view = (id: string, workerId: string): ViewRecord => ({
  id, workerId, title: "Two places", createdAt: 1000, kind: "view",
  spec: { title: "Two places", ui: '<List of="places"/>', summary: "Two.", data: { places: [{ id: 1, type: "Place", name: "Çiya" }] } },
});

let db: DatabaseSync;
let repo: SqliteGenuiViewRepo;
beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog);
  repo = new SqliteGenuiViewRepo(db);
});

describe("064_genui_views", () => {
  it("follows 063 and creates both tables", () => {
    const ids = MIGRATIONS.map((m) => m.id);
    assert.equal(ids.indexOf("064_genui_views"), ids.indexOf("063_dream_candidates") + 1);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'genui_%'").all() as Array<{ name: string }>).map((r) => r.name).sort();
    assert.deepEqual(tables, ["genui_view_state", "genui_views"]);
  });

  it("re-running the runner is a no-op", () => {
    assert.equal(runMigrations(db, noopLog), 0);
  });
});

describe("SqliteGenuiViewRepo", () => {
  it("round-trips a view", () => {
    repo.save(view("v_aaaaaaaaaaaa", "orch"));
    assert.deepEqual(repo.get("v_aaaaaaaaaaaa"), view("v_aaaaaaaaaaaa", "orch"));
    assert.equal(repo.get("v_bbbbbbbbbbbb"), null);
  });

  it("stores every scenario board as presented, and reads it back whole", () => {
    let id = 0;
    const deps: PresentViewDeps = {
      views: repo,
      clock: { now: () => 42 },
      newId: () => `v_${String(++id).padStart(12, "0")}`,
      validateView,
      validateApp,
      settings: () => ({ level: "rich", apps: true }),
    };
    for (const name of ["restaurants", "trip", "tests", "learn"]) {
      const r = presentView(deps, "orch", fixture(name));
      const back = repo.get(r.viewId);
      assert.ok(back, `${name} reads back`);
      assert.equal(back.kind, "view");
      assert.deepEqual(back.spec, fixture(name), name);
    }
    const app = presentApp(deps, "orch", fixture("app"));
    const back = repo.get(app.viewId);
    assert.equal(back?.kind, "app");
    assert.deepEqual(back?.spec, fixture("app"));
  });

  it("drops a row that no longer validates instead of returning it", () => {
    db.prepare("INSERT INTO genui_views (id, worker_id, kind, title, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("v_cccccccccccc", "orch", "view", "t", "{not json", 1);
    assert.equal(repo.get("v_cccccccccccc"), null);
    db.prepare("INSERT INTO genui_views (id, worker_id, kind, title, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("v_dddddddddddd", "orch", "nope", "t", "{}", 1);
    assert.equal(repo.get("v_dddddddddddd"), null);
  });

  it("keeps state per view, last write wins", () => {
    const id = newViewId();
    repo.save(view(id, "orch"));
    assert.equal(repo.getState(id), null);
    repo.putState(id, { day: 1 }, 10);
    repo.putState(id, { day: 2, done: ["a"] }, 20);
    assert.deepEqual(repo.getState(id), { state: { day: 2, done: ["a"] }, updatedAt: 20 });
  });

  it("removes a worker's views and their state, and nobody else's", () => {
    repo.save(view("v_aaaaaaaaaaaa", "orch"));
    repo.save(view("v_bbbbbbbbbbbb", "other"));
    repo.putState("v_aaaaaaaaaaaa", { x: 1 }, 1);
    repo.putState("v_bbbbbbbbbbbb", { x: 2 }, 1);
    repo.removeByWorker("orch");
    assert.equal(repo.get("v_aaaaaaaaaaaa"), null);
    assert.equal(repo.getState("v_aaaaaaaaaaaa"), null);
    assert.ok(repo.get("v_bbbbbbbbbbbb"));
    assert.deepEqual(repo.getState("v_bbbbbbbbbbbb")?.state, { x: 2 });
  });
});
