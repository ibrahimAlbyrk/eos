    -- Capabilities: what is installed and how it stands, every version of
    -- each package (the active one, earlier ones to go back to, proposals),
    -- and one row per call of an action. A package's files live in
    -- ~/.eos/capabilities; its secrets in Eos's own Keychain items, never
    -- here. Settings and account labels are the user's data. The previous
    -- app version never reads these tables.
    CREATE TABLE IF NOT EXISTS capability_installs (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,            -- builtin | forge | registry | synced
      active_version TEXT,             -- none for a built-in
      state TEXT NOT NULL,             -- ready | degraded | needs_sign_in | needs_setup | broken | disabled | available
      state_code TEXT,
      state_since INTEGER NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,  -- in a row
      settings_json TEXT NOT NULL DEFAULT '{}',
      account_label TEXT,
      installed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS capability_versions (
      capability_id TEXT NOT NULL,
      version TEXT NOT NULL,
      status TEXT NOT NULL,            -- proposed | installed | retired | rejected
      hash TEXT NOT NULL,              -- of the package's files, checked before its code runs
      manifest_json TEXT NOT NULL,
      source TEXT NOT NULL,            -- a Forge run's id, or a pinned package
      tests_json TEXT,
      review_json TEXT,
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      retired_at INTEGER,
      PRIMARY KEY (capability_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_capability_versions_created ON capability_versions(capability_id, created_at);
    -- Ids, kinds and outcomes only: never an action's input or output.
    CREATE TABLE IF NOT EXISTS capability_calls (
      id TEXT PRIMARY KEY,
      capability_id TEXT NOT NULL,
      action TEXT NOT NULL,
      class TEXT NOT NULL,
      caller_kind TEXT NOT NULL,
      worker_id TEXT,
      run_id TEXT,
      version TEXT,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      outcome TEXT NOT NULL,           -- ok | error | denied | timeout | busy
      error_kind TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_capability_calls_started ON capability_calls(capability_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_capability_calls_run ON capability_calls(run_id)
