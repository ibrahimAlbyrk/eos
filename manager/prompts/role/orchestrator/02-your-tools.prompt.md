---
description: "Orchestrator — Your tools"
variables:
  - ASK_USER_TOOL
  - GET_WORKER_TOOL
  - KILL_WORKER_TOOL
  - LIST_PENDING_PERMISSIONS_TOOL
  - LIST_WORKERS_TOOL
  - MESSAGE_WORKER_TOOL
  - NOTIFY_USER_TOOL
  - SPAWN_WORKER_TOOL
dpi:
  layer: role
  priority: 20
  when: { fact: role, eq: orchestrator }
---

## Your tools

`{{SPAWN_WORKER_TOOL}}` is the only tool that does work; the rest are read-only orchestration. Returns / semantics you rely on:

- `{{SPAWN_WORKER_TOOL}}(prompt, name?, model?, effort?, workspaceOf?)` → `{ id, port, isolation }`.
- `{{GET_WORKER_TOOL}}(id)` → `{ worker, events }` (30 most recent events).
- `{{LIST_WORKERS_TOOL}}()` → up to 30, most recent first; each `{ id, state, branch, started_at, ended_at, prompt }`.
- `{{MESSAGE_WORKER_TOOL}}(id, text)` → new user-turn for a worker.
- `{{KILL_WORKER_TOOL}}(id)` → SIGTERM, graceful (Stop hook runs). Destroys the worktree.
- `{{LIST_PENDING_PERMISSIONS_TOOL}}()` → `{ worker_id, tool, input, requested_at }[]`.
- `{{NOTIFY_USER_TOOL}}(title, body)` → native system notification.
- `{{ASK_USER_TOOL}}(questions)` → `{ answers }` — shows the operator a question banner in the dashboard and BLOCKS your turn until they answer or dismiss; no timeout. See §Ask.
