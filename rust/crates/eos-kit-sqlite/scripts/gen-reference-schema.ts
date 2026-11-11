// The schema today's TypeScript runner builds on an empty file, as the rows of
// sqlite_master. The Rust runner must build the same objects, text for text.
//
//   node rust/crates/eos-kit-sqlite/scripts/gen-reference-schema.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runMigrations, setIncrementalIfNew } from "../../../../infra/src/persistence/MigrationRunner.ts";

const dir = mkdtempSync(join(tmpdir(), "eos-schema-"));
const noop = (): void => {};
const log = { debug: noop, info: noop, warn: noop, error: noop, child: () => log };
// Opened the way manager/container.ts opens state.db.
const db = new DatabaseSync(join(dir, "state.db"));
setIncrementalIfNew(db);
db.exec("PRAGMA journal_mode = WAL");
const applied = runMigrations(db, log as never);
const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
const pragma = (name: string): unknown => (db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name];
const reference = {
  applied,
  autoVacuum: pragma("auto_vacuum"),
  journalMode: pragma("journal_mode"),
  ids: (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id),
  objects,
};
db.close();
rmSync(dir, { recursive: true, force: true });
writeFileSync(join(import.meta.dirname, "..", "tests", "fixtures", "ts-schema.json"), `${JSON.stringify(reference, null, 2)}\n`);
console.log(`${objects.length} objects from ${applied} migrations`);
