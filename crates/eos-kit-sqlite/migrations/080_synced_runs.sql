    -- Summaries of runs the user's other computers finished, as sync brought
    -- them: no result and no transcript, shown read-only and kept 30 days.
    -- The previous app version never reads this table.
    CREATE TABLE IF NOT EXISTS synced_runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      device TEXT NOT NULL,
      ended_at INTEGER NOT NULL,
      summary_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_synced_runs_routine ON synced_runs(routine_id, ended_at)
