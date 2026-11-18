    -- Runs of routines: the run, its timeline and its results. One write job
    -- moves a run, appends its event and announces it, so a run's state and
    -- its timeline never disagree. The previous app version never reads
    -- these tables.
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      version_id TEXT,
      kind TEXT NOT NULL,              -- standing | project | once | trial | design | app-build | ask
      origin TEXT NOT NULL,
      origin_ref TEXT,
      door TEXT,
      input TEXT NOT NULL,
      item_key TEXT,
      state TEXT NOT NULL,
      station TEXT,
      reason TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      resumed INTEGER NOT NULL DEFAULT 0,
      not_before INTEGER,
      priority INTEGER NOT NULL,
      progress_done INTEGER,
      progress_total INTEGER,
      headline TEXT,
      outcome TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      work_ms INTEGER NOT NULL DEFAULT 0,
      lead_id TEXT,
      device TEXT NOT NULL,
      remote INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_routine ON runs(routine_id, created_at DESC);
    -- The runs that have not ended, in the order the queue takes them.
    CREATE INDEX IF NOT EXISTS idx_runs_live ON runs(state, priority, created_at)
      WHERE state IN ('queued','running','checking','waiting_for_user','delivering','paused');
    CREATE INDEX IF NOT EXISTS idx_runs_item ON runs(routine_id, item_key);
    -- One run per signal a routine's trigger matched, even when two matches race.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_signal ON runs(routine_id, origin_ref) WHERE origin = 'trigger';
    CREATE INDEX IF NOT EXISTS idx_runs_ended ON runs(ended_at);
    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data TEXT                        -- ids, states, counts; never outside text
    );
    CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
    CREATE TABLE IF NOT EXISTS run_results (
      run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      kind TEXT NOT NULL,
      headline TEXT NOT NULL,
      body TEXT NOT NULL,
      files TEXT,
      verdict TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, attempt)
    )
