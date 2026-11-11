
    CREATE TABLE IF NOT EXISTS worker_definitions (
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner, name)
    )
  