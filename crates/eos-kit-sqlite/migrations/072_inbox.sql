    -- Needs you: the items that wait for the user, the deliveries of routine
    -- results, the user's edits of results before they went out, what became
    -- of each result, the offers of more freedom and the one switch that
    -- stops everything. An answer is one write guarded by the item's rev, so
    -- the Mac and the phone cannot both answer one item. Titles, summaries,
    -- payloads, drafts, bodies and targets are the user's data. The previous
    -- app version never reads these tables.
    CREATE TABLE IF NOT EXISTS inbox_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,             -- open | later | answered | replaced | expired | withdrawn
      producer TEXT NOT NULL,          -- the module that made it
      routine_id TEXT,
      run_id TEXT,
      subject_key TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload TEXT NOT NULL,           -- JSON per kind, at most 256 KiB
      working TEXT,                    -- the user's saved edits
      rev INTEGER NOT NULL,            -- one up per write
      attention TEXT NOT NULL,         -- interrupt | digest | silent
      stale_at INTEGER,
      stale_reason TEXT,
      later_until INTEGER,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      answered_at INTEGER,
      answered_by TEXT,                -- dashboard | phone | peer | system
      answer TEXT,
      replaced_by TEXT,
      consumed_at INTEGER,
      notified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_items_state ON inbox_items(state, created_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_routine ON inbox_items(routine_id, state);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_subject ON inbox_items(subject_key, state);
    CREATE INDEX IF NOT EXISTS idx_inbox_items_run ON inbox_items(run_id);
    -- The answered items each producer has yet to act on.
    CREATE INDEX IF NOT EXISTS idx_inbox_items_handoff ON inbox_items(producer, state, consumed_at);
    CREATE TABLE IF NOT EXISTS inbox_deliveries (
      id TEXT PRIMARY KEY,             -- the idempotency key of every attempt
      item_id TEXT,
      run_id TEXT NOT NULL,
      routine_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      action TEXT NOT NULL,
      target_ref TEXT NOT NULL,        -- the Goes-to recipient's id
      target TEXT NOT NULL,            -- JSON, from the checked recipient, never from a model's text
      body TEXT NOT NULL,              -- the ResultDoc as JSON
      body_hash TEXT NOT NULL,
      class TEXT NOT NULL,
      mode TEXT NOT NULL,              -- approved | auto | grant:<id>
      state TEXT NOT NULL,             -- queued | holding | sending | sent | undone | failed | uncertain | stopped | frozen | waiting_capability
      send_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      last_error_kind TEXT,
      partial TEXT,                    -- what a two-step send left between its steps
      receipt TEXT,
      sent_at INTEGER,
      undo_until INTEGER,
      undone_at INTEGER,
      approved_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_deliveries_due ON inbox_deliveries(state, next_attempt_at);
    -- One send at a time per target, oldest first.
    CREATE INDEX IF NOT EXISTS idx_inbox_deliveries_target ON inbox_deliveries(target_ref, state, created_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_deliveries_run ON inbox_deliveries(run_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_deliveries_item ON inbox_deliveries(item_id);
    -- Numbered in the order they were made: memory reads them from a cursor.
    CREATE TABLE IF NOT EXISTS inbox_edits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      delivery_id TEXT,
      routine_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      result_kind TEXT NOT NULL,
      before TEXT NOT NULL,
      after TEXT NOT NULL,
      ops TEXT NOT NULL,               -- the part edits as JSON
      changed INTEGER NOT NULL,
      removed INTEGER NOT NULL,
      added INTEGER NOT NULL,
      moved INTEGER NOT NULL,
      derived_from_untrusted INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_edits_routine ON inbox_edits(routine_id, at);
    CREATE INDEX IF NOT EXISTS idx_inbox_edits_at ON inbox_edits(at);
    -- The streak of a routine is read from its last outcomes.
    CREATE TABLE IF NOT EXISTS inbox_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      routine_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      item_id TEXT,
      delivery_id TEXT,
      outcome TEXT NOT NULL,           -- sent_unedited | sent_edited | discarded | expired | replaced | undone | wrong | auto_sent | auto_clean | held_flags
      rung TEXT NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_outcomes_routine ON inbox_outcomes(routine_id, at);
    CREATE TABLE IF NOT EXISTS inbox_offers (
      routine_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,             -- none | offered | declined | never
      item_id TEXT,
      streak_at INTEGER,
      next_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    -- One row, id 1, once the switch was first used; none means off.
    CREATE TABLE IF NOT EXISTS inbox_halt (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      "on" INTEGER NOT NULL,
      since INTEGER,
      by TEXT,
      updated_at INTEGER NOT NULL
    )
