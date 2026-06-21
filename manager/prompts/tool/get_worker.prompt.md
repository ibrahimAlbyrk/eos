---
description: "MCP tool — get_worker"
variables:
  - GET_WORKER_TOOL
  - SEND_MESSAGE_TO_PARENT_TOOL
---

Get a worker's full state plus its 30 most recent events. Only works on workers you spawned.

When to use: the user explicitly asks for an update on a specific worker, or you need to inspect why a worker just reported `failed:` to decide how to recover.

When NOT to use: as a polling mechanism after spawning. Workers report via {{SEND_MESSAGE_TO_PARENT_TOOL}} — wait for that signal rather than polling. Calling {{GET_WORKER_TOOL}} repeatedly wastes context with no new information.

Returns: { worker: {id, state, model, prompt, started_at, ...}, events: [...] }. Events include tool calls, permission requests, and lifecycle markers; the most recent event is last in the array.
