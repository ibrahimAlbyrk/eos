    -- Surfaces: the interfaces a routine's runs answer with outside a chat.
    -- Each surface belongs to one routine; its design versions are
    -- immutable while an issue uses them; an issue holds a run's data or
    -- View, never rendered HTML. Images and exports live in
    -- ~/.eos/surfaces. Titles, bodies, state, edits and action arguments and
    -- results are the user's data. The previous app version never reads
    -- these tables.
    CREATE TABLE IF NOT EXISTS surface_defs (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      level TEXT NOT NULL,             -- view | page | app
      place TEXT NOT NULL,             -- routine_page | needs_you | side_panel | tool
      role TEXT NOT NULL,              -- result | decisions | page | app
      title TEXT NOT NULL,
      current_version INTEGER,
      candidate_version INTEGER,
      needs_redesign TEXT,             -- JSON: the problem paths of the last fallbacks
      archived_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_surface_defs_routine ON surface_defs(routine_id);
    CREATE TABLE IF NOT EXISTS surface_versions (
      surface_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,            -- checking | candidate | kept | discarded | superseded
      base_version INTEGER,
      made_by TEXT NOT NULL,           -- designer | user | arrange | restore | builder
      run_id TEXT,
      note TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL,              -- JSON
      body_bytes INTEGER NOT NULL,
      checks TEXT NOT NULL DEFAULT '{}',  -- JSON
      created_at INTEGER NOT NULL,
      kept_at INTEGER,
      PRIMARY KEY (surface_id, version)
    );
    CREATE TABLE IF NOT EXISTS surface_issues (
      id TEXT PRIMARY KEY,
      surface_id TEXT NOT NULL,
      seq INTEGER,                     -- none for a trial issue
      run_id TEXT,
      version INTEGER,
      kind TEXT NOT NULL,              -- page | view | fallback
      status TEXT NOT NULL,            -- preparing | ready | failed
      body TEXT NOT NULL,              -- JSON
      rev INTEGER NOT NULL DEFAULT 1,
      images TEXT NOT NULL DEFAULT '[]',  -- JSON
      trial INTEGER NOT NULL DEFAULT 0,
      kept INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_surface_issues_surface ON surface_issues(surface_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_surface_issues_run ON surface_issues(run_id);
    CREATE TABLE IF NOT EXISTS surface_edits (
      issue_id TEXT NOT NULL,
      rev INTEGER NOT NULL,
      op TEXT NOT NULL,
      path TEXT NOT NULL,
      before TEXT,                     -- JSON
      after TEXT,                      -- JSON
      at INTEGER NOT NULL,
      PRIMARY KEY (issue_id, rev)
    );
    CREATE TABLE IF NOT EXISTS surface_state (
      surface_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT '',  -- '' for the surface, or an issue id
      data TEXT NOT NULL,              -- JSON
      bytes INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (surface_id, scope)
    );
    CREATE TABLE IF NOT EXISTS surface_pins (
      slot INTEGER PRIMARY KEY,        -- 1 to 3
      surface_id TEXT NOT NULL UNIQUE,
      pinned_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS surface_action_log (
      id TEXT PRIMARY KEY,
      client_id TEXT UNIQUE,
      action_id TEXT NOT NULL,
      surface_id TEXT,
      issue_id TEXT,
      routine_id TEXT,
      origin TEXT NOT NULL,            -- dashboard | phone | mail_link | app
      class TEXT NOT NULL,
      args TEXT NOT NULL,              -- JSON
      decision TEXT NOT NULL,          -- run | confirm | hold | refuse
      status TEXT NOT NULL,            -- running | done | failed | confirming | held | refused
      result TEXT,                     -- JSON
      error_kind TEXT,
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_surface_action_log_surface ON surface_action_log(surface_id, created_at)
