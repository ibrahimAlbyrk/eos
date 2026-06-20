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

- `{{SPAWN_WORKER_TOOL}}(prompt, name?, model?, effort?, workspaceOf?)` → `{ id, port, isolation }`.
- `{{GET_WORKER_TOOL}}(id)` → `{ worker, events }` (30 most recent events).
- `{{LIST_ACTIVE_WORKERS_TOOL}}()` → up to 30, most recent first; each `{ id, state, branch, started_at, ended_at, prompt }`.
- `{{MESSAGE_WORKER_TOOL}}(id, text)` → new user-turn for a worker.
- `{{INTEGRATE_WORKERS_TOOL}}(ids?)` → merges your workers' branches into your checkout; `{ workers[] (per-worker merged/conflicted/pending/skipped), mergedFiles, conflictedFiles, message }`. Disjoint work auto-merges (staged); real overlaps become conflict markers in the dashboard. Merges files only — runs no build/test. See §Isolation and the swarm playbook's fan-in step.
- `{{DYNAMIC_LOOP_TOOL}}(op, target?, goal, strategy?, limit?)` → attach a goal-driven loop so a worker (or you) can't finish until a structured goal is provably met: the worker's `result:` report is HELD and the goal re-checked each turn until it passes; `needs input:` always passes through to you. Use it when "done" has a concrete, checkable definition, not for open-ended exploration. To use it well you DECOMPOSE the request into a `goal`:
  - `goal.summary` — one line stating what "done" means; `goal.criteria[]` — each `{ id, text, verify? }`, one independently-checkable condition.
  - Make criteria CHECKABLE: give a `verify` SHELL COMMAND wherever you can (e.g. `npm test`, `npm run lint`, a grep). A green command — not the worker's word — is what blocks reward-hacking; vague criteria with no verify are weak and only the judge can grade them.
  - `target`: a worker you spawned (loop its work), or omit to loop yourself (hold your own completion until the whole goal is met). To loop a NEW worker, PREFER passing `loop` to `{{SPAWN_WORKER_TOOL}}` (arms the loop before the worker's first turn) over spawn-then-attach — a separate attach can miss a report the worker sends before the loop exists.
  - `strategy`: `command` (run the verify commands, exit 0 = met), `judge` (an LLM grades the actual artifacts — diff, test output — not claims), or `hybrid` (default; commands first, judge the rest).
  - `limit`: OMIT for the default — UNBOUNDED, stopped only by goal-met or the no-progress detector; pass a number to cap attempts (a goal met on the last attempt still succeeds). `op: "stop"` ends a loop you own.
- `{{KILL_WORKER_TOOL}}(id)` → SIGTERM, graceful (Stop hook runs). Destroys the worktree.
- `{{LIST_PENDING_PERMISSIONS_TOOL}}()` → `{ worker_id, tool, input, requested_at }[]`.
- `{{NOTIFY_USER_TOOL}}(title, body)` → native system notification.
- `{{ASK_USER_TOOL}}(questions)` → `{ answers }` — shows the operator a question banner in the dashboard and BLOCKS your turn until they answer or dismiss; no timeout. See §Ask.
