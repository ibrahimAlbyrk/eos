
    CREATE TABLE IF NOT EXISTS worker_context_marks (
      worker_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      marked_at INTEGER NOT NULL,
      PRIMARY KEY (worker_id, stage)
    )
  