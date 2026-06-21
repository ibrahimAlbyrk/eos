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
  { id: "020_workers_add_backend_kind", sql: "ALTER TABLE workers ADD COLUMN backend_kind TEXT" },
  { id: "021_workers_add_backend_profile", sql: "ALTER TABLE workers ADD COLUMN backend_profile TEXT" },
  { id: "022_backfill_backend_kind", sql: "UPDATE workers SET backend_kind = 'claude-cli' WHERE backend_kind IS NULL" },
  { id: "023_workers_add_agent_role", sql: "ALTER TABLE workers ADD COLUMN agent_role TEXT" },
  { id: "024_workers_add_turn_started_at", sql: "ALTER TABLE workers ADD COLUMN turn_started_at INTEGER" },
  { id: "025_workers_add_session_id", sql: "ALTER TABLE workers ADD COLUMN session_id TEXT" },
  { id: "026_workers_add_with_gateway", sql: "ALTER TABLE workers ADD COLUMN with_gateway INTEGER" },
  { id: "027_workers_add_fork_base_sha", sql: "ALTER TABLE workers ADD COLUMN fork_base_sha TEXT" },
  { id: "028_workers_add_workspace_owner_id", sql: "ALTER TABLE workers ADD COLUMN workspace_owner_id TEXT" },
  // Daemon-side message queue + idempotency ledger: dispatched_at NULL = pending
  // (delivered at the worker's next IDLE), set = dedup/audit row. The UNIQUE
  // index is the idempotency guarantee — a duplicate (worker, clientMsgId)
  // insert is a no-op, so one message can never become two turns.
  { id: "029_queued_messages", sql: `
    CREATE TABLE IF NOT EXISTS queued_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      client_msg_id TEXT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_qm_worker_client ON queued_messages(worker_id, client_msg_id);
    CREATE INDEX IF NOT EXISTS idx_qm_worker_dispatched ON queued_messages(worker_id, dispatched_at);
  `},
  // Fresh-worktree rows are born 0 and flip to 1 when the worker's
  // claude_spawning event confirms the tree exists on disk; reading the
  // precomputed worktree_dir before that misattributes the source repo's
  // diff to the worker (`git -C` walks up from a not-yet-worktree dir).
  { id: "030_workers_add_workspace_ready", sql: "ALTER TABLE workers ADD COLUMN workspace_ready INTEGER DEFAULT 0" },
  // Pre-existing rows are past their boot window — treat as materialized.
  { id: "031_backfill_workspace_ready", sql: "UPDATE workers SET workspace_ready = 1" },
  // beforeId/afterId pagination filters on (worker_id, id); the (worker_id, ts)
  // index can't serve the id condition, so deltas degrade to rowid range scans
  // across all workers as the table grows.
  { id: "032_idx_events_worker_id", sql: "CREATE INDEX IF NOT EXISTS idx_events_worker_id ON events(worker_id, id)" },
  // Context footprint of the worker's last turn, stamped by addUsage on every
  // usage event. The web context ring reads this column directly — the old
  // scan-recent-events approach broke whenever a busy turn's hook/jsonl tail
  // pushed all usage events out of the fetched window.
  { id: "033_workers_last_context_tokens", sql: "ALTER TABLE workers ADD COLUMN last_context_tokens INTEGER" },
  // Backfill from each worker's newest usage event. Sum all four token kinds:
  // cache-cold turns (model switch, expired cache TTL) report the whole
  // context as cacheCreate*, not cacheRead.
  { id: "034_backfill_last_context_tokens", sql: `
    UPDATE workers SET last_context_tokens = (
      SELECT COALESCE(json_extract(e.payload,'$.in'),0)
           + COALESCE(json_extract(e.payload,'$.cacheRead'),0)
           + COALESCE(json_extract(e.payload,'$.cacheCreate'),0)
           + COALESCE(json_extract(e.payload,'$.cacheCreate1h'),0)
      FROM events e
      WHERE e.worker_id = workers.id AND e.type = 'usage'
      ORDER BY e.id DESC LIMIT 1
    )
  ` },
  // JSON snapshot of the agent's task list, stamped from each TodoWrite tool
  // call (the worker's jsonl tool_use events). The web TaskTray reads this
  // column directly — no event-scan.
  { id: "035_workers_add_tasks", sql: "ALTER TABLE workers ADD COLUMN tasks TEXT" },
  // Backfill from each worker's newest TodoWrite tool_use event so a running
  // agent's existing list shows immediately (not only after its next update).
  { id: "036_backfill_tasks", sql: `
    UPDATE workers SET tasks = (
      SELECT json_extract(e.payload,'$.input.todos')
      FROM events e
      WHERE e.worker_id = workers.id
        AND e.type = 'jsonl'
        AND json_extract(e.payload,'$.kind') = 'tool_use'
        AND json_extract(e.payload,'$.name') = 'TodoWrite'
      ORDER BY e.id DESC LIMIT 1
    )
  ` },
  // Backfill the incremental TaskCreate system: build the list from every
  // TaskCreate event in creation order, all as pending (status changes via
  // TaskUpdate are not replayed here — the next live update corrects them).
  // Only for workers TodoWrite didn't already fill.
  { id: "037_backfill_taskcreate", sql: `
    UPDATE workers SET tasks = (
      SELECT json_group_array(json_object(
        'content', json_extract(payload,'$.input.subject'),
        'status', 'pending',
        'activeForm', json_extract(payload,'$.input.activeForm')
      ))
      FROM (
        SELECT payload FROM events
        WHERE worker_id = workers.id
          AND type = 'jsonl'
          AND json_extract(payload,'$.kind') = 'tool_use'
          AND json_extract(payload,'$.name') = 'TaskCreate'
        ORDER BY id
      )
    )
    WHERE tasks IS NULL
      AND EXISTS (
        SELECT 1 FROM events e
        WHERE e.worker_id = workers.id
          AND e.type = 'jsonl'
          AND json_extract(e.payload,'$.name') = 'TaskCreate'
      )
  ` },
  // Collapse the permission-mode model from 4 modes to 2 (acceptEdits +
  // bypassPermissions). Legacy rows holding the removed "default"/"plan" modes
  // are rewritten to the safe default so resolution + UI selection stay valid.
  { id: "038_collapse_permission_modes", sql: `
    UPDATE workers SET permission_mode = 'acceptEdits'
    WHERE permission_mode IN ('default','plan')
  ` },
  { id: "039_workers_add_collaborate", sql: "ALTER TABLE workers ADD COLUMN collaborate INTEGER" },
  // Durable worktree-removal queue. Worktree teardown used to be an in-memory
  // setTimeout fired AFTER the worker row was already deleted — a daemon
  // crash/SIGKILL (eos restart/build pkill -9) in that window stranded the
  // worktree with no row pointing at it. The intent is now persisted here
  // before the row is dropped; a reaper drains it on boot + on an interval, so
  // removal survives a restart. id = worker id (a worker is deleted once).
  { id: "040_pending_worktree_removals", sql: `
    CREATE TABLE IF NOT EXISTS pending_worktree_removals (
      id TEXT PRIMARY KEY,
      worker_id TEXT,
      repo_root TEXT NOT NULL,
      worktree_dir TEXT,
      branch TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL
    )
  `},
  // Agent-plane routing (envelope + displayText) for a message queued behind a
  // busy parent. Without it a drained worker report replays as a plain
  // user_message — losing its kind and showing the routing wrapper. NULL for
  // legacy rows and plain dashboard sends.
  { id: "041_queued_messages_add_meta", sql: "ALTER TABLE queued_messages ADD COLUMN meta TEXT" },
  // Resolved worker-definition name, set once at spawn. Drives the DPI
  // workerDefinition fact + the body fragment re-resolution on resume. NULL for
  // untyped workers and all pre-migration rows. (Column renamed to
  // worker_definition by migration 046; this historical ADD keeps its original name.)
  { id: "042_workers_add_worker_type", sql: "ALTER TABLE workers ADD COLUMN worker_type TEXT" },
  // Materialized tool scope (JSON ToolScope: allow/deny globs + editRegex), baked
  // at spawn. The policy gateway reads it per tool call. NULL ⇒ no restriction.
  { id: "043_workers_add_tool_scope", sql: "ALTER TABLE workers ADD COLUMN tool_scope TEXT" },
  // Visibility plane for a queued message. "user" = a human's pending message
  // (renders as a pill); "agent" = internal agent-plane traffic (worker report/
  // directive/peer) that still drains into the transcript at the next IDLE but
  // must NEVER surface as a user pill. The pill endpoint reads user-plane only.
  { id: "044_queued_messages_add_plane", sql: "ALTER TABLE queued_messages ADD COLUMN plane TEXT NOT NULL DEFAULT 'user'" },
  // In-flight rows at upgrade: a pending row carrying routing meta IS agent-plane
  // (only report/directive/peer persist an envelope). Reclassify so a report
  // already queued behind a busy parent stops leaking into the pill list.
  { id: "045_backfill_queued_messages_plane", sql: "UPDATE queued_messages SET plane = 'agent' WHERE meta IS NOT NULL" },
  // Rename the worker-type column to worker_definition — the "worker type" concept
  // is now "worker definition" (an available worker) end to end. RENAME COLUMN
  // preserves existing values (definition names like "git").
  { id: "046_workers_rename_worker_type_to_worker_definition", sql: "ALTER TABLE workers RENAME COLUMN worker_type TO worker_definition" },
  // Dynamic loops: a goal the orchestrator attaches to a worker (or itself) so
  // the agent can't finish until the goal is met. goal_json holds the GoalSpec;
  // progress_ring is the no-progress/oscillation fingerprint buffer. The partial
  // UNIQUE index on (worker_id) WHERE status='active' enforces one active loop
  // per target — the duplicate-active guard in attachLoop, backstopped at the DB.
  { id: "047_worker_loops", sql: `
    CREATE TABLE IF NOT EXISTS worker_loops (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      parent_id TEXT,
      goal_json TEXT NOT NULL,
      strategy TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER,
      held_report TEXT,
      last_reason TEXT,
      progress_ring TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worker_loops_worker ON worker_loops(worker_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_loops_active ON worker_loops(worker_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_worker_loops_status ON worker_loops(status);
  `},
  // A looped worker that reports needs-input is blocked on the human's answer.
  // awaiting_input pauses the goal-gate (no re-trigger, no attempt burned) while
  // the loop stays status='active' — so findActiveByWorker + the unique-active
  // index are untouched. Cleared when the orchestrator's answer reaches the worker.
  { id: "048_worker_loops_awaiting_input", sql: `
    ALTER TABLE worker_loops ADD COLUMN awaiting_input INTEGER NOT NULL DEFAULT 0;
  `},
  // Name provenance for the auto-name micro-task. Nullable, NO DEFAULT, NO
  // BACKFILL on purpose: pre-existing rows become NULL = legacy/ineligible. The
  // auto-name gate requires name_source = 'default', and NULL ≠ 'default', so
  // legacy orchestrators are never auto-renamed. New rows set it at insert.
  { id: "049_workers_add_name_source", sql: "ALTER TABLE workers ADD COLUMN name_source TEXT" },
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
    "SELECT COUNT(*) AS n FROM workers WHERE state NOT IN ('DONE','KILLING','SUSPENDED')",
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
