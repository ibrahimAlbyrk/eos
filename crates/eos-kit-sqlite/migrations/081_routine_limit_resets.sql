    -- What was here before a spend cap a routine leaves out meant no cap: each
    -- routine then (its dollar caps were filled in by default) and, as the
    -- empty id, the overall day budget. Eos takes those caps off once and
    -- forgets the row. The previous app version never reads this table.
    CREATE TABLE IF NOT EXISTS routine_limit_resets AS
      SELECT id AS routine_id FROM routines UNION ALL SELECT ''
