
    CREATE TABLE IF NOT EXISTS pending_worktree_removals (
      id TEXT PRIMARY KEY,
      worker_id TEXT,
      repo_root TEXT NOT NULL,
      worktree_dir TEXT,
      branch TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL
    )
  