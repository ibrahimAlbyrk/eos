
    UPDATE workers SET tasks = (
      SELECT json_group_array(json_object(
        'content', json_extract(payload,'$.input.subject'),
        'status', 'pending',
        'activeForm', json_extract(payload,'$.input.activeForm')
      ))
      FROM (
        SELECT payload FROM events
        WHERE worker_id = workers.id
          AND type = 'jsonl'
          AND json_extract(payload,'$.kind') = 'tool_use'
          AND json_extract(payload,'$.name') = 'TaskCreate'
        ORDER BY id
      )
    )
    WHERE tasks IS NULL
      AND EXISTS (
        SELECT 1 FROM events e
        WHERE e.worker_id = workers.id
          AND e.type = 'jsonl'
          AND json_extract(e.payload,'$.name') = 'TaskCreate'
      )
  