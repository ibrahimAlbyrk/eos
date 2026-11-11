// Runs the TypeScript migration runner and two repos against a state.db copy
// that the Rust runner has already added a migration to. Never point it at a
// live data folder.
import { DatabaseSync } from "node:sqlite";

import { MIGRATIONS, runMigrations } from "../../../../infra/src/persistence/MigrationRunner.ts";
import { SqliteEventRepo } from "../../../../infra/src/persistence/SqliteEventRepo.ts";
import { SqliteWorkerRepo } from "../../../../infra/src/persistence/SqliteWorkerRepo.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: ts-runner-check.ts <state.db copy>");

const logs: string[] = [];
const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), debug: () => {} };

const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL");
const ran = runMigrations(db, log as never);
const recorded = (db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>).map((r) => r.id);
const known = new Set(MIGRATIONS.map((m) => m.id));

const workers = new SqliteWorkerRepo(db);
const events = new SqliteEventRepo(db, 0);
const all = workers.listAll();
const probeWorker = "rs-spike-probe-worker";
const rowId = events.append(probeWorker, 1, "text", { hello: "from ts" });
const back = events.list({ workerId: probeWorker, since: 0, limit: 10 } as never);
db.prepare("DELETE FROM events WHERE worker_id = ?").run(probeWorker);

console.log(JSON.stringify({
  sqlite: (db.prepare("select sqlite_version() v").get() as { v: string }).v,
  migrationsRunByTs: ran,
  unknownToTs: recorded.filter((id) => !known.has(id)),
  workersListed: all.length,
  workerRowHasExtraColumn: all.length > 0 && "rs_spike_probe" in (all[0] as object),
  appendedRowId: rowId > 0,
  readBack: back.length,
  logs,
}));
db.close();
