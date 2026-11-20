    -- Memory: notes learned from the user's corrections and the work's
    -- outcomes, the hooks that bring them back, the links between them,
    -- their meaning vectors, evidence, versions and per-Mac counters. Note
    -- text and evidence summaries are the user's data, cleaned before they
    -- are written; nothing here holds a message, a tool's input or output,
    -- or a secret. The previous app version never reads these tables.
    CREATE TABLE IF NOT EXISTS mem_notes (
      rowid INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,         -- mn-…
      kind TEXT NOT NULL,              -- episode | lesson | fact | skill | example | playbook
      text TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '{}', -- JSON, by kind
      cues TEXT NOT NULL DEFAULT '',   -- the hooks' keys split into words, for search by words
      trust TEXT NOT NULL,             -- said | did | outcome | guess
      state TEXT NOT NULL,             -- trying | firm | cooling | closed
      scope_level TEXT NOT NULL,       -- routine | project | work | everywhere
      scope_key TEXT NOT NULL DEFAULT '',
      valid_from INTEGER NOT NULL,
      valid_to INTEGER,
      replaced_by TEXT,
      do_hooks TEXT NOT NULL DEFAULT '[]',
      avoid_hooks TEXT NOT NULL DEFAULT '[]',
      -- Sums of mem_credit over every Mac.
      helped INTEGER NOT NULL DEFAULT 0,
      hurt INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      activation REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      device TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 1,
      forgotten_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_mem_notes_scope ON mem_notes(scope_level, scope_key, state);
    CREATE INDEX IF NOT EXISTS idx_mem_notes_kind ON mem_notes(kind, created_at);
    CREATE INDEX IF NOT EXISTS idx_mem_notes_updated ON mem_notes(updated_at);
    CREATE TABLE IF NOT EXISTS mem_hooks (
      id TEXT PRIMARY KEY,             -- mh-…, the same on every Mac
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      degree INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_hooks_key ON mem_hooks(kind, key);
    -- Between notes and hooks, either way.
    CREATE TABLE IF NOT EXISTS mem_links (
      a TEXT NOT NULL,
      b TEXT NOT NULL,
      rel TEXT NOT NULL,               -- about | because | replaces | refines | same | seen_together
      weight REAL NOT NULL DEFAULT 1,
      co_uses INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (a, b, rel)
    );
    CREATE INDEX IF NOT EXISTS idx_mem_links_b ON mem_links(b);
    CREATE TABLE IF NOT EXISTS mem_vectors (
      note_rowid INTEGER PRIMARY KEY,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      scale REAL NOT NULL,
      vec BLOB NOT NULL                -- int8, dims long
    );
    CREATE TABLE IF NOT EXISTS mem_evidence (
      id TEXT PRIMARY KEY,
      note_id TEXT NOT NULL,
      kind TEXT NOT NULL,              -- the moment's signal
      summary TEXT NOT NULL,           -- at most 200 characters, cleaned
      worker_id TEXT,
      row_from INTEGER,
      row_to INTEGER,
      run_id TEXT,
      at INTEGER NOT NULL,
      device TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mem_evidence_note ON mem_evidence(note_id, at);
    CREATE TABLE IF NOT EXISTS mem_versions (
      note_id TEXT NOT NULL,
      rev INTEGER NOT NULL,
      text TEXT NOT NULL,
      body TEXT NOT NULL,
      scope_level TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      state TEXT NOT NULL,
      why TEXT NOT NULL,               -- learned | corrected | edited | merged | narrowed | restored
      at INTEGER NOT NULL,
      PRIMARY KEY (note_id, rev)
    );
    -- This Mac's counters, and every other Mac's as synced.
    CREATE TABLE IF NOT EXISTS mem_credit (
      note_id TEXT NOT NULL,
      device TEXT NOT NULL,
      helped INTEGER NOT NULL DEFAULT 0,
      hurt INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER,
      PRIMARY KEY (note_id, device)
    );
    -- What belongs to a note goes with it.
    CREATE TRIGGER IF NOT EXISTS mem_notes_gone AFTER DELETE ON mem_notes BEGIN
      DELETE FROM mem_links WHERE a = old.id OR b = old.id;
      DELETE FROM mem_vectors WHERE note_rowid = old.rowid;
      DELETE FROM mem_evidence WHERE note_id = old.id;
      DELETE FROM mem_versions WHERE note_id = old.id;
      DELETE FROM mem_credit WHERE note_id = old.id;
    END;
