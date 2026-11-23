    -- Every one-off made, by its kind of task: "Keep as a routine?" counts the
    -- one-offs of a kind over 30 days, while a one-off nobody kept leaves
    -- with all its rows 7 days after its run. The previous app version never
    -- reads this table.
    CREATE TABLE IF NOT EXISTS routine_once_asks (
      routine_id TEXT PRIMARY KEY,
      task_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routine_once_asks_key ON routine_once_asks(task_key, created_at)
