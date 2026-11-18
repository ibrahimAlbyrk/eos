    -- Signals: what starts routines' runs. A source is one place Eos learns
    -- from (the clock, a capability's list on one scope, a folder, a branch);
    -- a signal is one thing it saw, once per key; a route is what became of
    -- one signal for one routine; schedules and runners are the scheduler's
    -- and the leases' state. Keys, subjects, scopes and facts are the user's
    -- data. The previous app version never reads these tables.
    CREATE TABLE IF NOT EXISTS signal_sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,              -- clock | manual | capability | folder | git | after | push-inbox
      source TEXT,                     -- a capability's source: github.pulls
      scope_json TEXT NOT NULL,        -- canonical JSON
      scope_hash TEXT NOT NULL,
      cursor_json TEXT,                -- the source's own, handed back as it was
      state TEXT NOT NULL,             -- active | backing-off | needs-attention | off | stopped
      error_kind TEXT,                 -- unreachable | unauthorized | gone | no-access | rate-limited
      failures INTEGER NOT NULL DEFAULT 0,
      interval_ms INTEGER NOT NULL,
      last_poll_at INTEGER,
      next_poll_at INTEGER,
      last_signal_at INTEGER,
      catch_up_json TEXT,              -- {at, items, gapMs} of the last poll after a gap over 15 min
      stopped_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- One source serves every routine with the same source and scope.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_sources_scope ON signal_sources(scope_hash);
    CREATE INDEX IF NOT EXISTS idx_signal_sources_due ON signal_sources(state, next_poll_at);
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      key TEXT NOT NULL,
      subject TEXT NOT NULL,
      version TEXT,
      kind TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      facts_json TEXT,                 -- at most 16 KB; cleared after 7 days unless a run needs it
      item_json TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL              -- received | routed
    );
    -- One thing seen twice by a source is one signal.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_key ON signals(source_id, key);
    CREATE INDEX IF NOT EXISTS idx_signals_state ON signals(state, id);
    CREATE INDEX IF NOT EXISTS idx_signals_subject ON signals(subject, received_at);
    CREATE TABLE IF NOT EXISTS signal_routes (
      signal_id INTEGER NOT NULL,
      routine_id TEXT NOT NULL,
      routine_version TEXT NOT NULL,
      decision TEXT NOT NULL,
      reason TEXT,                     -- a short code, or the index of the rule that failed
      run_id TEXT,
      model_asked INTEGER NOT NULL DEFAULT 0,
      decided_at INTEGER NOT NULL,
      PRIMARY KEY (signal_id, routine_id)
    );
    CREATE INDEX IF NOT EXISTS idx_signal_routes_routine ON signal_routes(routine_id, decided_at);
    CREATE INDEX IF NOT EXISTS idx_signal_routes_decision ON signal_routes(routine_id, decision, decided_at);
    CREATE INDEX IF NOT EXISTS idx_signal_routes_run ON signal_routes(run_id);
    CREATE TABLE IF NOT EXISTS signal_schedules (
      routine_id TEXT NOT NULL,
      slot INTEGER NOT NULL,           -- the schedule's place in the routine's When list
      spec_hash TEXT NOT NULL,
      zone TEXT NOT NULL,
      armed_at INTEGER NOT NULL,
      last_slot_at INTEGER,
      next_at INTEGER,
      missed INTEGER NOT NULL DEFAULT 0,
      late_by_ms INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (routine_id, slot)
    );
    -- This computer's copy of who holds each routine, as the vault last said.
    CREATE TABLE IF NOT EXISTS signal_runners (
      routine_id TEXT PRIMARY KEY,
      holder_device TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      seen_seq INTEGER NOT NULL,
      seen_at INTEGER NOT NULL,
      handoff_json TEXT
    )
