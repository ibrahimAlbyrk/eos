
    CREATE TABLE IF NOT EXISTS genui_views (
      id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS genui_views_worker ON genui_views (worker_id);
    CREATE TABLE IF NOT EXISTS genui_view_state (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  