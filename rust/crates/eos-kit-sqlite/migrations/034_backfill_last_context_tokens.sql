
    UPDATE workers SET last_context_tokens = (
      SELECT COALESCE(json_extract(e.payload,'$.in'),0)
           + COALESCE(json_extract(e.payload,'$.cacheRead'),0)
           + COALESCE(json_extract(e.payload,'$.cacheCreate'),0)
           + COALESCE(json_extract(e.payload,'$.cacheCreate1h'),0)
      FROM events e
      WHERE e.worker_id = workers.id AND e.type = 'usage'
      ORDER BY e.id DESC LIMIT 1
    )
  