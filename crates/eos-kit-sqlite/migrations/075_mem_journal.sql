    -- Memory's journal and bookkeeping: the moments found in conversations
    -- (row ranges and cues, never text), how far each log was read, which
    -- notes rode in which session, stated rules' provenance, forgotten
    -- notes, playbook replays, the switches and the day's model calls. The
    -- previous app version never reads these tables.
    CREATE TABLE IF NOT EXISTS mem_moments (
      id TEXT PRIMARY KEY,             -- mm-…
      worker_id TEXT NOT NULL,
      source TEXT NOT NULL,            -- agent | code | run
      run_id TEXT,
      signal TEXT NOT NULL,
      trust TEXT NOT NULL,
      row_from INTEGER NOT NULL,
      row_to INTEGER NOT NULL,
      cues TEXT NOT NULL DEFAULT '[]', -- [{kind, key}]
      state TEXT NOT NULL,             -- pending | reflected | skipped | failed
      note_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mem_moments_state ON mem_moments(state, created_at);
    CREATE INDEX IF NOT EXISTS idx_mem_moments_worker ON mem_moments(worker_id);
    CREATE TABLE IF NOT EXISTS mem_cursors (
      key TEXT PRIMARY KEY,            -- a worker id, inbox-edits, or pty:<claude session>
      last_row INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mem_uses (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      worker_id TEXT,
      run_id TEXT,
      how TEXT NOT NULL,               -- pack | reminder | tool
      epoch INTEGER NOT NULL DEFAULT 0,
      at INTEGER NOT NULL,
      acted INTEGER NOT NULL DEFAULT 0,
      outcome TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mem_uses_worker ON mem_uses(worker_id, epoch);
    CREATE INDEX IF NOT EXISTS idx_mem_uses_note ON mem_uses(note_id, at);
    CREATE INDEX IF NOT EXISTS idx_mem_uses_run ON mem_uses(run_id);
    CREATE TABLE IF NOT EXISTS mem_stated (
      memory_id TEXT PRIMARY KEY,      -- an um- (About you) or mn- id
      worker_id TEXT NOT NULL,
      row_id INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mem_forgotten (
      note_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,       -- JSON: hooks and meaning, to refuse relearning
      snapshot TEXT NOT NULL,          -- JSON: the note, to undo
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mem_forgotten_at ON mem_forgotten(at);
    CREATE TABLE IF NOT EXISTS mem_replays (
      id TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      items INTEGER NOT NULL,
      old_score REAL NOT NULL,
      new_score REAL NOT NULL,
      kept INTEGER NOT NULL,
      at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mem_replays_routine ON mem_replays(routine_id, at);
    CREATE TABLE IF NOT EXISTS mem_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mem_daily (
      day TEXT PRIMARY KEY,            -- local date, YYYY-MM-DD
      classifier INTEGER NOT NULL DEFAULT 0,
      reflections INTEGER NOT NULL DEFAULT 0,
      night_calls INTEGER NOT NULL DEFAULT 0
    );
