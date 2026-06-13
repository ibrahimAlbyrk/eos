---
description: "MCP tool — list_workers"
---

List the workers you spawned (active and completed), most recent first, up to 30 entries. Workers belonging to other orchestrators or spawned directly by the user are not visible to you.

When to use: the user asks 'what's running?' or 'show me workers', or you need to find a worker by name when you don't have the id.

When NOT to use: as a polling mechanism after spawning. The dashboard already shows worker state to the user; repeated calls waste context with no new information.

Returns: array of { id, name, state, branch, started_at, ended_at, prompt (first 100 chars) }. State is one of: spawning, running, idle, completed, failed, killed.
