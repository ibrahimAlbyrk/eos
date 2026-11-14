
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
  