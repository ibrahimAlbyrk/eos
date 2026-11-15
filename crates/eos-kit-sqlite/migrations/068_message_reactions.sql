    -- One emoji per actor ('user' | 'agent') per message; event_id is the
    -- message's events.id. `told` is the emoji the agent was last told about
    -- (the user's reactions only). A reaction taken back keeps its row, emoji
    -- NULL, until the agent has heard of it. Nothing here needs a build that
    -- knows the table: reads skip rows whose message is gone, and start-up
    -- sweeps them.
    CREATE TABLE IF NOT EXISTS message_reactions (
      event_id   INTEGER NOT NULL,
      actor      TEXT    NOT NULL,
      worker_id  TEXT    NOT NULL,
      emoji      TEXT,
      told       TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (event_id, actor)
    );
    CREATE INDEX IF NOT EXISTS idx_message_reactions_worker ON message_reactions(worker_id, event_id)
