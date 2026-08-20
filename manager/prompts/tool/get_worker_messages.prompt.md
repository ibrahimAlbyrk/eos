---
description: "MCP tool — get_worker_messages"
variables:
  - GET_WORKER_TOOL
---

Fetch the last `n` conversation messages of a worker you spawned — what it actually said
and was told, normalized (tool calls, usage, and heartbeats are filtered out). For scalar
state — state, branch, context occupancy, loop — use {{GET_WORKER_TOOL}} instead.

When to use: recovering context before a handoff (e.g. a worker near its context limit),
inspecting how a worker reached a conclusion, or drafting a follow-up that builds on its
exact words.

Not a polling channel: workers report via their parent report — wait for that signal
rather than re-reading transcripts.

Pass `id` and optionally `n` (1-50, default 5; `1` = just the latest). Returns
`{ messages }` — the worker's `n` most recent messages.
