---
description: "MCP tool — list_pending_permissions"
---

List permission requests from your workers currently waiting for human approval — tool calls that hit a policy 'ask' rule.

When to use:
- The user told you a worker is stuck or quiet and you suspect a permission ask.
- You want to surface pending decisions to the user proactively (e.g., before spawning more workers).

An empty list is itself useful — it means none of your workers are blocked on permissions.

Returns: array of { worker_id, tool, input, requested_at }. The user can approve or deny via the dashboard; alternatively the user can tell you to approve via a policy rule.
