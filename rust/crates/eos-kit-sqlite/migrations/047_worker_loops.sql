
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
  