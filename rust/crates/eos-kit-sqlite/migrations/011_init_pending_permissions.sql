
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
  