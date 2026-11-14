
    CREATE TABLE IF NOT EXISTS queued_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      worker_id TEXT NOT NULL,
      client_msg_id TEXT,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_qm_worker_client ON queued_messages(worker_id, client_msg_id);
    CREATE INDEX IF NOT EXISTS idx_qm_worker_dispatched ON queued_messages(worker_id, dispatched_at);
  