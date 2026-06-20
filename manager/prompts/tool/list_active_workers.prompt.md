---
description: "MCP tool — list_active_workers"
variables:
  - LIST_AVAILABLE_WORKERS_TOOL
---

List the workers you spawned (active and completed), most recent first, up to 30 entries. Workers belonging to other orchestrators or spawned directly by the user are not visible to you.

NOT the catalog of what you could spawn — this lists instances you already spawned. For the blueprints available to spawn from, use {{LIST_AVAILABLE_WORKERS_TOOL}}.

When to use: the user asks 'what's running?' or 'show me workers', or you need to find a worker by name when you don't have the id.

When NOT to use: as a polling mechanism after spawning. The dashboard already shows worker state to the user; repeated calls waste context with no new information.

Returns: array of { id, name, worker_definition, state, branch, started_at, ended_at, prompt (first 100 chars) }. worker_definition is the available-worker the worker was spawned from ("" when spawned inline, null for orchestrators). State is one of: spawning, running, idle, completed, failed, killed.
