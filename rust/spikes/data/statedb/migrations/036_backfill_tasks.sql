
    UPDATE workers SET tasks = (
      SELECT json_extract(e.payload,'$.input.todos')
      FROM events e
      WHERE e.worker_id = workers.id
        AND e.type = 'jsonl'
        AND json_extract(e.payload,'$.kind') = 'tool_use'
        AND json_extract(e.payload,'$.name') = 'TodoWrite'
      ORDER BY e.id DESC LIMIT 1
    )
  