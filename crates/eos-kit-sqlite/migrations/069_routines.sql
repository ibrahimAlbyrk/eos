    -- Routines: the routine itself, every version of its blueprint (immutable
    -- rows, the blueprint as canonical JSON), the draft its architect works
    -- on, the sessions Eos starts for it, what it spent by local day and kind,
    -- and the routines Eos suggested. A blueprint lives here rather than in a
    -- file because no agent's file tools write state.db, so no run can rewrite
    -- its own recipients. The previous app version never reads these tables.
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,              -- standing | project | once
      state TEXT NOT NULL,             -- draft | active | paused | archived | deleted | transient
      paused_reason TEXT,
      head_version_id TEXT,
      origin TEXT NOT NULL,            -- architect | hand | once | copy | suggestion | sync | builtin
      task_key TEXT,
      agents_may_start INTEGER NOT NULL DEFAULT 0,
      failure_streak INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      changed_at INTEGER NOT NULL,     -- last change of what syncs
      started_at INTEGER,
      deleted_at INTEGER
    );
    -- A slug names one live routine; a deleted or one-off routine lets go of it.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_routines_slug ON routines(slug) WHERE state NOT IN ('deleted','transient');
    CREATE TABLE IF NOT EXISTS routine_versions (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      parent_id TEXT,
      status TEXT NOT NULL,            -- draft | kept | discarded
      author TEXT NOT NULL,            -- user | architect | eos | restore | sync | once
      note TEXT,
      format INTEGER NOT NULL,
      blueprint TEXT NOT NULL,
      hash TEXT NOT NULL,
      no_trial INTEGER NOT NULL DEFAULT 0,
      trust TEXT NOT NULL DEFAULT 'trusted',
      device TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routine_versions_routine ON routine_versions(routine_id, created_at);
    CREATE TABLE IF NOT EXISTS routine_drafts (
      routine_id TEXT PRIMARY KEY,
      purpose TEXT NOT NULL,
      architect_id TEXT,
      base_version_id TEXT,
      draft_version_id TEXT,
      question TEXT,
      status TEXT NOT NULL,            -- working | asking | trying | ready | abandoned
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- Every session Eos starts for a routine, written before the session
    -- starts, so its first event already finds it.
    CREATE TABLE IF NOT EXISTS routine_sessions (
      worker_id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      run_id TEXT,
      role TEXT NOT NULL,              -- architect | solo | lead | script | specialist | checker
      agent_key TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routine_sessions_run ON routine_sessions(run_id);
    CREATE TABLE IF NOT EXISTS routine_spend (
      day TEXT NOT NULL,
      routine_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      cost_usd REAL NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (day, routine_id, kind)
    );
    CREATE TABLE IF NOT EXISTS routine_suggestions (
      key TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      inbox_id TEXT,
      created_at INTEGER NOT NULL
    )
