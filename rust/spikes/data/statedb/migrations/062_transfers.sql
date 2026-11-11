
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS transfers_created ON transfers (created_at DESC);
  