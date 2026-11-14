
    CREATE TABLE IF NOT EXISTS worker_message_ids (
      worker_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      sub INTEGER NOT NULL
    )
  