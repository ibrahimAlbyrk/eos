
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      definition_name TEXT,
      owner TEXT NOT NULL,
      anchor_id TEXT NOT NULL,
      status TEXT NOT NULL,
      args_json TEXT,
      result_json TEXT,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  