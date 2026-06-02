// Versioned migrations. Each entry is applied once, in order. Adding a new
// schema change means appending an entry — never mutate or reorder existing
// ones. `schema_migrations.id` records what's been run.
//
// SQLite's ALTER TABLE doesn't support IF NOT EXISTS for columns, so the
// migration runner skips already-recorded entries. ADD COLUMN on an existing
// column throws but we never re-run a recorded one. Pre-versioning DBs may
// have already-applied columns; we treat "duplicate column"/"already exists"
// as recoverable and just record the migration.

import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import { errMsg } from "../../../contracts/src/util.ts";

export interface Migration { id: string; sql: string }

export const MIGRATIONS: Migration[] = [
  { id: "001_init_workers", sql: `
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      cwd TEXT,
      worktree_from TEXT,
      branch TEXT,
      prompt TEXT NOT NULL,
      name TEXT,
      pid INTEGER,
      port INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      exit_code INTEGER
    )
  `},
  { id: "002_workers_add_parent_id", sql: "ALTER TABLE workers ADD COLUMN parent_id TEXT" },
  { id: "003_workers_add_model", sql: "ALTER TABLE workers ADD COLUMN model TEXT" },
  { id: "004_workers_add_tokens_in", sql: "ALTER TABLE workers ADD COLUMN tokens_in INTEGER DEFAULT 0" },
  { id: "005_workers_add_tokens_out", sql: "ALTER TABLE workers ADD COLUMN tokens_out INTEGER DEFAULT 0" },
  { id: "006_workers_add_tokens_cache_read", sql: "ALTER TABLE workers ADD COLUMN tokens_cache_read INTEGER DEFAULT 0" },
  { id: "007_workers_add_tokens_cache_create", sql: "ALTER TABLE workers ADD COLUMN tokens_cache_create INTEGER DEFAULT 0" },
  { id: "008_workers_add_cost_usd", sql: "ALTER TABLE workers ADD COLUMN cost_usd REAL DEFAULT 0" },
  { id: "009_init_events", sql: `
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT
    )
  `},
  { id: "010_idx_events_worker_ts", sql: "CREATE INDEX IF NOT EXISTS idx_events_worker_ts ON events(worker_id, ts)" },
  { id: "011_init_pending_permissions", sql: `
    CREATE TABLE IF NOT EXISTS pending_permissions (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      tool_use_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      decision TEXT,
      reason TEXT,
      updated_input TEXT
    )
  `},
  { id: "012_idx_pending_unresolved", sql: "CREATE INDEX IF NOT EXISTS idx_pending_unresolved ON pending_permissions(resolved, expires_at)" },
  { id: "013_workers_add_is_orchestrator", sql: "ALTER TABLE workers ADD COLUMN is_orchestrator INTEGER DEFAULT 0" },
  { id: "014_backfill_existing_orchestrator", sql: "UPDATE workers SET is_orchestrator = 1 WHERE id = 'orchestrator'" },
  { id: "015_workers_add_tool_calls", sql: "ALTER TABLE workers ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0" },
  { id: "016_workers_add_permission_mode", sql: "ALTER TABLE workers ADD COLUMN permission_mode TEXT" },
  { id: "017_workers_add_effort", sql: "ALTER TABLE workers ADD COLUMN effort TEXT" },
  { id: "018_workers_add_tokens_cache_create_1h", sql: "ALTER TABLE workers ADD COLUMN tokens_cache_create_1h INTEGER DEFAULT 0" },
  { id: "019_workers_add_worktree_dir", sql: "ALTER TABLE workers ADD COLUMN worktree_dir TEXT" },
];

export function runMigrations(db: DatabaseSync, log: Logger): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set<string>();
  for (const row of db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>) {
    applied.add(row.id);
  }
  const insert = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)");
  let ranCount = 0;
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    try {
      db.exec(m.sql);
      insert.run(m.id, Date.now());
      ranCount++;
    } catch (e) {
      const msg = errMsg(e);
      if (/duplicate column|already exists/i.test(msg)) {
        insert.run(m.id, Date.now());
      } else {
        log.error("migration failed", { id: m.id, error: msg });
        throw e;
      }
    }
  }
  if (ranCount > 0) log.info("applied migrations", { count: ranCount });
  return ranCount;
}

// Periodic VACUUM. SQLite never shrinks pages after a DELETE wave (worker
// terminations) — VACUUM rebuilds the file and reclaims space. We track the
// last run in schema_migrations under a reserved id so it survives restarts.
export const VACUUM_MARKER = "__vacuum_last_run";
export const VACUUM_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function maybeVacuum(db: DatabaseSync, log: Logger, reason: string): void {
  const busy = db.prepare(
    "SELECT COUNT(*) AS n FROM workers WHERE state NOT IN ('DONE','KILLING')",
  ).get() as { n: number } | undefined;
  if (busy && busy.n > 0) return;

  const last = db.prepare("SELECT applied_at FROM schema_migrations WHERE id = ?").get(VACUUM_MARKER) as { applied_at: number } | undefined;
  const now = Date.now();
  if (last && now - last.applied_at < VACUUM_INTERVAL_MS) return;

  try {
    const before = Date.now();
    db.exec("VACUUM");
    const ms = Date.now() - before;
    if (last) db.prepare("UPDATE schema_migrations SET applied_at = ? WHERE id = ?").run(now, VACUUM_MARKER);
    else db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(VACUUM_MARKER, now);
    log.info("VACUUM ok", { ms, reason });
  } catch (e) {
    log.warn("VACUUM failed", { error: errMsg(e) });
  }
}
