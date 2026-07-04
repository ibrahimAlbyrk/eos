---
description: "Orchestrator — Your tools"
variables:
  - ASK_USER_TOOL
  - DYNAMIC_LOOP_TOOL
  - GET_WORKER_TOOL
  - INTEGRATE_WORKERS_TOOL
  - KILL_WORKER_TOOL
  - LIST_PENDING_PERMISSIONS_TOOL
  - LIST_ACTIVE_WORKERS_TOOL
  - MESSAGE_WORKER_TOOL
  - NOTIFY_USER_TOOL
  - SPAWN_WORKER_TOOL
dpi:
  layer: role
  priority: 20
  when: { fact: role, eq: orchestrator }
---

## Your tools

`{{SPAWN_WORKER_TOOL}}` (run work) and `{{INTEGRATE_WORKERS_TOOL}}` (pull work onto your branch) are the two tools that change state; the rest are read-only orchestration. Returns / semantics you rely on:

- `{{SPAWN_WORKER_TOOL}}(prompt, name?, model?, effort?, workspaceOf?)` → `{ id, isolation }`.
- `{{GET_WORKER_TOOL}}(id)` → `{ worker }` (decision-relevant fields only; use `{{GET_WORKER_MESSAGES_TOOL}}` for the conversation). `worker.context` is `{ used, limit, pct }` — tokens of the model window in use (`pct`/`limit` null when the window is unknown).
- `{{LIST_ACTIVE_WORKERS_TOOL}}()` → up to 30, most recent first; each `{ id, state, branch, context_pct, started_at, ended_at, prompt }` (`context_pct` = percent of the model window in use, null when unknown).
- `{{MESSAGE_WORKER_TOOL}}(id, text)` → new user-turn for a worker.
- `{{INTEGRATE_WORKERS_TOOL}}(ids?)` → merges your workers' branches into your checkout; `{ ok, branch, workers[] (per-worker merged/conflicted/pending/skipped, each with its own files[]), message }`. Merges files only, runs no build/test — full mechanics + outcome states in the tool description; fan-in strategy in §Isolation and the swarm playbook.
- `{{DYNAMIC_LOOP_TOOL}}(op, target?, goal, strategy?, limit?)` → arms a goal gate: a looped worker's `result:` is HELD and the goal re-checked each turn until it passes; `needs input:` always passes through. Decompose the request into a checkable `goal` (criteria with `verify` shell commands beat the worker's word) — full mechanics in the tool description; when-to-use in the §Swarm test phase.
- `{{KILL_WORKER_TOOL}}(id)` → SIGTERM, graceful (Stop hook runs). Destroys the worktree.
- `{{LIST_PENDING_PERMISSIONS_TOOL}}()` → `{ id, worker_id, tool_name, input, expires_at }[]`.
- `{{NOTIFY_USER_TOOL}}(title, body)` → native system notification.
- `{{ASK_USER_TOOL}}(questions)` → `{ answers }` — shows the operator a question banner in the dashboard and BLOCKS your turn until they answer or dismiss; no timeout. See §Ask.
