---
description: "MCP tool — list_pending_permissions"
---

List permission requests from your workers currently waiting for human approval — tool calls that hit a policy 'ask' rule.

When to use:
- A `system_message kind="permission_ask"` just arrived — one of your workers' asks was created. Confirm it is still live here before surfacing it: the ask may have been resolved or expired since the push, and there is no follow-up signal.
- The user told you a worker is stuck or quiet and you suspect a permission ask.
- You want to surface pending decisions to the user proactively (e.g., before spawning more workers).

An empty list is itself useful — it means none of your workers are blocked on permissions.

Returns: array of `{ id, worker_id, tool_name, input, created_at, expires_at, resolved }` — one row per worker tool-call paused on an `ask` rule. `tool_name`/`input` say what is being asked; `created_at`/`expires_at` are epoch-ms (an ask can expire unanswered). There is no approve/deny tool for you — only the operator (dashboard) or a policy rule can clear these; surface them in chat, do not try to resolve them yourself.
