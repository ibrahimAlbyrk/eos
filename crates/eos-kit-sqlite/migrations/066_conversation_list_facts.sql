    -- What the conversation-wide lists (a chat's subagents and artifacts) are
    -- derived from: the facts of each event row that can matter to them, kept
    -- beside the log. Regenerable from events. A build that does not know it
    -- appends events without it; conversation_list_marks says how far each
    -- worker's log was read in, so the rest is read in on demand, and counts
    -- every change of a worker's facts (version), so what was derived from
    -- them can be kept until they change.
    CREATE TABLE IF NOT EXISTS conversation_list_facts (
      event_id INTEGER PRIMARY KEY,
      worker_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      facts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_list_facts_worker ON conversation_list_facts (worker_id, event_id);
    CREATE TABLE IF NOT EXISTS conversation_list_marks (
      worker_id TEXT PRIMARY KEY,
      through_id INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 0
    );
