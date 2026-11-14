    -- The session this app continues each chat in. workers.session_id stays
    -- the TypeScript app's: the Claude Code session it resumes a chat by
    -- (`claude --resume <uuid>`), which it must still find there after a
    -- user went back to it. A chat begun in this app has no Claude Code
    -- session: its row here is the only session it has.
    CREATE TABLE IF NOT EXISTS engine_sessions (
      worker_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    -- Earlier builds of this app wrote their own id (the worker's) into
    -- workers.session_id. It moves here, and the Claude Code session the
    -- chat had goes back from the newest resume row that names one (every
    -- resume logs the session it resumed). A chat begun in this app, or one
    -- whose log no longer holds such a row, is left without one.
    INSERT OR IGNORE INTO engine_sessions (worker_id, session_id)
      SELECT id, id FROM workers WHERE session_id = id;
    UPDATE workers SET session_id = (
      SELECT json_extract(e.payload, '$.sessionId') FROM events e
      WHERE e.worker_id = workers.id AND e.type = 'spawn'
        AND CASE WHEN json_valid(e.payload) THEN json_extract(e.payload, '$.sessionId') GLOB
          '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
          ELSE 0 END
      ORDER BY e.id DESC LIMIT 1
    ) WHERE session_id = id
