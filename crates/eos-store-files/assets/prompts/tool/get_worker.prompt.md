---
description: "MCP tool — get_worker"
variables:
  - GET_WORKER_TOOL
  - GET_WORKER_MESSAGES_TOOL
  - SEND_MESSAGE_TO_PARENT_TOOL
---

Get a worker's decision-relevant state. Only works on workers you spawned. For the conversation itself, use `{{GET_WORKER_MESSAGES_TOOL}}`.

When to use: the user explicitly asks for an update on a specific worker, or you need to inspect why a worker just reported `failed:` to decide how to recover.

When NOT to use: as a polling mechanism after spawning. Workers report via {{SEND_MESSAGE_TO_PARENT_TOOL}} — wait for that signal rather than polling. Calling {{GET_WORKER_TOOL}} repeatedly wastes context with no new information.

Returns: { worker: { id, name, state, branch, prompt, started_at, ended_at, exit_code, model, context, loop, worker_definition, cost_usd, parent_id, tasks } }. `context` is `{ used, limit, pct }` window occupancy; `loop` is the active dynamic-loop status, if any.
