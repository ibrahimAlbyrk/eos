
    CREATE TABLE IF NOT EXISTS dream_runs (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dream_runs_started ON dream_runs (started_at DESC);
    CREATE TABLE IF NOT EXISTS dream_watermarks (
      worker_id TEXT PRIMARY KEY,
      last_event_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dream_exclusions (
      worker_id TEXT PRIMARY KEY
    );
  