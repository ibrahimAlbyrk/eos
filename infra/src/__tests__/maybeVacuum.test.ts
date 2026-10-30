import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { maybeVacuum, runMigrations, setIncrementalIfNew, VACUUM_MARKER, VACUUM_SLICE_PAGES } from "../persistence/MigrationRunner.ts";

const noopLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => noopLog };

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vacuum-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Opened the way container.ts opens state.db; `legacy` = a file created before setIncrementalIfNew.
function open(legacy = false): DatabaseSync {
  const file = join(dir, "state.db");
  if (legacy) {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE legacy (x)");
    old.close();
  }
  const db = new DatabaseSync(file);
  setIncrementalIfNew(db);
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db, noopLog as never);
  return db;
}

const pragma = (db: DatabaseSync, name: string) => (db.prepare(`PRAGMA ${name}`).get() as Record<string, number | string>)[name];
const insert = (db: DatabaseSync) => db.prepare("INSERT INTO events (worker_id, ts, type, payload) VALUES (?, ?, ?, ?)");

// Frees `pages` pages: one 4 KB-overflow row per page, then a delete wave.
function freePages(db: DatabaseSync, pages: number): void {
  const ins = insert(db);
  const payload = "x".repeat(4000);
  db.exec("BEGIN");
  for (let i = 0; i < pages; i++) ins.run("w-gone", i, "jsonl", payload);
  db.exec("COMMIT");
  db.prepare("DELETE FROM events WHERE worker_id = ?").run("w-gone");
}

describe("maybeVacuum", () => {
  it("shrinks an incremental file in slices while the same connection keeps writing", async () => {
    const db = open();
    assert.equal(pragma(db, "auto_vacuum"), 2, "a new file is born incremental");
    freePages(db, VACUUM_SLICE_PAGES * 8);
    const freed = pragma(db, "freelist_count") as number;
    assert.ok(freed >= VACUUM_SLICE_PAGES * 8);
    const pagesBefore = pragma(db, "page_count") as number;

    const ins = insert(db);
    let written = 0;
    let duringRun = 0;
    let running = true;
    const writer = setInterval(() => {
      ins.run("w-live", Date.now(), "jsonl", "{}");
      written++;
      if (running) duringRun++;
    }, 1);
    await maybeVacuum(db, noopLog as never, "test");
    running = false;
    clearInterval(writer);

    assert.ok(duringRun > 0, "the writer ran between slices");
    assert.equal(pragma(db, "freelist_count"), 0);
    assert.ok((pragma(db, "page_count") as number) <= pagesBefore - freed + duringRun);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE worker_id = 'w-live'").get() as { n: number }).n, written);
    assert.equal(pragma(db, "quick_check"), "ok");
    assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(VACUUM_MARKER));
    db.close();
  });

  it("switches a file created without auto_vacuum with one full VACUUM", async () => {
    const db = open(true);
    assert.equal(pragma(db, "auto_vacuum"), 0);
    freePages(db, 64);
    await maybeVacuum(db, noopLog as never, "test");
    assert.equal(pragma(db, "auto_vacuum"), 2);
    assert.equal(pragma(db, "freelist_count"), 0);
    db.close();
  });

  it("waits while a worker is live and until the week is up", async () => {
    const db = open();
    db.prepare("INSERT INTO workers (id, state, prompt, started_at) VALUES ('w', 'WORKING', '', 0)").run();
    freePages(db, 64);
    await maybeVacuum(db, noopLog as never, "test");
    assert.ok((pragma(db, "freelist_count") as number) > 0, "skipped while a worker is live");

    db.prepare("UPDATE workers SET state = 'SUSPENDED'").run();
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(VACUUM_MARKER, Date.now());
    await maybeVacuum(db, noopLog as never, "test");
    assert.ok((pragma(db, "freelist_count") as number) > 0, "skipped inside the interval");
    db.close();
  });
});
