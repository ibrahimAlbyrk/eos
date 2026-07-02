import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkerRepo } from "../persistence/SqliteWorkerRepo.ts";
import { runMigrations, MIGRATIONS } from "../persistence/MigrationRunner.ts";
import type { InsertWorkerInput } from "../../../core/src/ports/WorkerRepo.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

function input(id: string, parentId: string | null, startedAt: number): InsertWorkerInput {
  return {
    id, prompt: "p", cwd: "/tmp", worktreeFrom: null, branch: null, name: null,
    nameSource: "default",
    pid: null, port: 7400, startedAt, parentId, model: "opus", effort: null,
    isOrchestrator: false, backendKind: "claude-cli", backendProfile: null,
    agentRole: null, withGateway: true, collaborate: false, worktreeDir: null, workspaceOwnerId: null,
    workspaceReady: true,
  };
}

let repo: SqliteWorkerRepo;
let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runMigrations(db, noopLog as never);
  repo = new SqliteWorkerRepo(db);
});

describe("SqliteWorkerRepo listByParent", () => {
  it("returns only the given parent's children, newest first", () => {
    repo.insert(input("w-a", "orch-1", 100));
    repo.insert(input("w-b", "orch-1", 200));
    repo.insert(input("w-c", "orch-2", 300));
    repo.insert(input("w-d", null, 400));
    assert.deepEqual(repo.listByParent("orch-1").map((w) => w.id), ["w-b", "w-a"]);
    assert.deepEqual(repo.listByParent("orch-2").map((w) => w.id), ["w-c"]);
    assert.deepEqual(repo.listByParent("orch-none").map((w) => w.id), []);
    assert.equal(repo.listAll().length, 4);
  });
});

describe("SqliteWorkerRepo billing ledger vs context occupancy", () => {
  it("addUsage accumulates the billing ledger and never touches last_context_tokens", () => {
    repo.insert(input("w-u", null, 100));
    repo.addUsage("w-u", { in: 1, out: 50, cacheRead: 133997, cacheCreate: 0, cacheCreate1h: 154, costUsd: 0.01 });
    repo.addUsage("w-u", { in: 10, out: 389, cacheRead: 5, cacheCreate: 0, cacheCreate1h: 126299, costUsd: 0.25 });
    const w = repo.findById("w-u");
    assert.equal(w?.tokens_in, 11);
    assert.equal(w?.tokens_out, 439);
    assert.equal(w?.tokens_cache_read, 134002);
    // Occupancy is a separate snapshot — addUsage leaves it untouched.
    assert.equal(w?.last_context_tokens ?? null, null);
  });

  it("setContextTokens overwrites the occupancy snapshot (latest wins, not summed)", () => {
    repo.insert(input("w-c", null, 100));
    repo.setContextTokens("w-c", 134152);
    assert.equal(repo.findById("w-c")?.last_context_tokens, 134152);
    repo.setContextTokens("w-c", 126309);
    assert.equal(repo.findById("w-c")?.last_context_tokens, 126309);
  });
});

describe("SqliteWorkerRepo workspace_ready", () => {
  it("persists 0 for a not-ready insert and flips via setWorkspaceReady", () => {
    repo.insert({ ...input("w-wt", null, 100), worktreeFrom: "/repo", branch: "eos-x", worktreeDir: "/repo/.eos/worktrees/eos-x", workspaceReady: false });
    assert.equal(repo.findById("w-wt")?.workspace_ready, 0);
    repo.setWorkspaceReady("w-wt");
    assert.equal(repo.findById("w-wt")?.workspace_ready, 1);
  });

  it("persists 1 for a ready insert (plain cwd / attach)", () => {
    repo.insert(input("w-cwd", null, 100));
    assert.equal(repo.findById("w-cwd")?.workspace_ready, 1);
  });
});

describe("SqliteWorkerRepo name provenance + CAS", () => {
  it("insert persists name_source; findById reads it back", () => {
    repo.insert({ ...input("w-d", null, 100), name: "Foo", nameSource: "default" });
    assert.equal(repo.findById("w-d")?.name_source, "default");
  });

  it("updateName writes both the name and its source", () => {
    repo.insert(input("w-n", null, 100));
    repo.updateName("w-n", "Renamed", "user");
    const w = repo.findById("w-n");
    assert.equal(w?.name, "Renamed");
    assert.equal(w?.name_source, "user");
  });

  it("updateNameIfSource swaps + returns true when current source matches 'default'", () => {
    repo.insert({ ...input("w-cas", null, 100), name: "old", nameSource: "default" });
    const changed = repo.updateNameIfSource("w-cas", "Auto Name Orchestrator", "default", "auto");
    assert.equal(changed, true);
    const w = repo.findById("w-cas");
    assert.equal(w?.name, "Auto Name Orchestrator");
    assert.equal(w?.name_source, "auto");
  });

  it("I1 — CAS NEVER clobbers a 'user' name: no-op + returns false", () => {
    repo.insert({ ...input("w-user", null, 100), name: "My Name", nameSource: "user" });
    const changed = repo.updateNameIfSource("w-user", "Auto Name Orchestrator", "default", "auto");
    assert.equal(changed, false);
    const w = repo.findById("w-user");
    assert.equal(w?.name, "My Name");      // untouched
    assert.equal(w?.name_source, "user");  // untouched
  });

  it("CAS no-ops on a legacy NULL row (NULL ≠ 'default') and returns false", () => {
    repo.insert(input("w-legacy", null, 100));
    db.prepare("UPDATE workers SET name_source = NULL WHERE id = 'w-legacy'").run();
    const changed = repo.updateNameIfSource("w-legacy", "Auto Name Orchestrator", "default", "auto");
    assert.equal(changed, false);
    assert.equal(repo.findById("w-legacy")?.name_source ?? null, null);
  });
});

describe("SqliteWorkerRepo archived_at", () => {
  it("setArchived(ts) stamps, setArchived(null) clears — round-trip via findById", () => {
    repo.insert(input("w-arc", null, 100));
    assert.equal(repo.findById("w-arc")?.archived_at ?? null, null);
    repo.setArchived("w-arc", 5000);
    assert.equal(repo.findById("w-arc")?.archived_at, 5000);
    repo.setArchived("w-arc", null);
    assert.equal(repo.findById("w-arc")?.archived_at ?? null, null);
  });

  it("listActive/listArchived partition exactly; listAll returns both", () => {
    repo.insert(input("w-live", null, 100));
    repo.insert(input("w-gone", null, 200));
    repo.setArchived("w-gone", 5000);
    assert.deepEqual(repo.listActive().map((w) => w.id), ["w-live"]);
    assert.deepEqual(repo.listArchived().map((w) => w.id), ["w-gone"]);
    assert.equal(repo.listAll().length, 2);
  });

  it("listByParent stays all-inclusive over archived children", () => {
    repo.insert(input("w-kid", "orch-1", 100));
    repo.setArchived("w-kid", 5000);
    assert.deepEqual(repo.listByParent("orch-1").map((w) => w.id), ["w-kid"]);
    assert.deepEqual(repo.findChildrenIds("orch-1"), ["w-kid"]);
  });
});

describe("migration 056 archived_at — NULL default, no backfill", () => {
  it("adds archived_at as NULL for a row that pre-existed the migration", () => {
    const fresh = new DatabaseSync(":memory:");
    fresh.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const rec = fresh.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, 0)");
    for (const m of MIGRATIONS) {
      if (m.id === "056_workers_add_archived_at") continue;
      fresh.exec(m.sql);
      rec.run(m.id);
    }
    fresh.prepare("INSERT INTO workers (id, state, prompt, started_at) VALUES ('legacy', 'IDLE', 'p', 1)").run();

    const ran = runMigrations(fresh, noopLog as never);
    assert.equal(ran, 1);
    assert.equal(new SqliteWorkerRepo(fresh).findById("legacy")?.archived_at ?? null, null);
  });

  it("re-running migrations is a no-op (duplicate column recoverable)", () => {
    assert.equal(runMigrations(db, noopLog as never), 0);
    repo.insert(input("w-r", null, 100));
    repo.setArchived("w-r", 7);
    assert.equal(repo.findById("w-r")?.archived_at, 7);
  });
});

describe("migration 049 name_source — strict gate, no backfill", () => {
  it("adds name_source as NULL for a row that pre-existed the migration", () => {
    const fresh = new DatabaseSync(":memory:");
    // Apply every migration EXCEPT 049, recording each as done — so 049 is the
    // only unapplied one regardless of how many migrations follow it.
    fresh.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const rec = fresh.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, 0)");
    for (const m of MIGRATIONS) {
      if (m.id === "049_workers_add_name_source") continue;
      fresh.exec(m.sql);
      rec.run(m.id);
    }
    // A legacy worker row, written before the column existed.
    fresh.prepare("INSERT INTO workers (id, state, prompt, started_at) VALUES ('legacy', 'IDLE', 'p', 1)").run();

    // Only 049 is unapplied — running it must NOT backfill the legacy row.
    const ran = runMigrations(fresh, noopLog as never);
    assert.equal(ran, 1);
    assert.equal(new SqliteWorkerRepo(fresh).findById("legacy")?.name_source ?? null, null);
  });
});
