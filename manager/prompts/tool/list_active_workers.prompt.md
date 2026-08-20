---
description: "MCP tool — list_active_workers"
variables:
  - LIST_AVAILABLE_WORKERS_TOOL
  - LIST_PENDING_PERMISSIONS_TOOL
---

List the workers you spawned (active and completed), most recent first, up to 30.
Workers belonging to other orchestrators or spawned directly by the user are not
visible to you.

NOT the catalog of what you could spawn — these are instances; for the blueprints, use
{{LIST_AVAILABLE_WORKERS_TOOL}}.

When to use: the user asks what's running, or you need a worker's id by name.

When NOT to use: as polling after spawning — the dashboard already shows worker state,
and repeated calls add nothing. And NOT to diagnose WHY a worker is quiet: a worker
waiting on a permission ask still shows `WORKING`/`IDLE` (there is no blocked state) —
use {{LIST_PENDING_PERMISSIONS_TOOL}} for permission blocks.

Returns: array of { id, name, worker_definition, state, branch, started_at, ended_at,
prompt (first 100 chars) }. `worker_definition` is "" for inline spawns, null for
orchestrators. `state` is the raw enum: `SPAWNING`, `WORKING`, `IDLE`, `ENDING`,
`DONE`, `KILLING`, `SUSPENDED`.
