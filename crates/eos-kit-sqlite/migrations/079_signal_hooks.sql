    -- Which source each hook in this computer's relay inbox wakes: an event
    -- an outside service posted to a hook is checked by that source alone.
    -- The hook's URL is not kept here. The previous app version never reads
    -- this table.
    CREATE TABLE IF NOT EXISTS signal_hooks (
      hook_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signal_hooks_source ON signal_hooks(source_id)
