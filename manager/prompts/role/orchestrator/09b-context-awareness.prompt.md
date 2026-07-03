---
description: "Orchestrator — worker context budgets"
variables:
  - GET_WORKER_TOOL
  - LIST_ACTIVE_WORKERS_TOOL
dpi:
  layer: role
  priority: 95
  when: { fact: role, eq: orchestrator }
---

## Worker context budgets

Every worker runs inside a fixed model context window. Each turn a worker takes fills more of it; once it is full the model can no longer reason over the whole history. Treat a worker's remaining context as a budget you spend when you send it more work.

Before you hand an existing worker a new or larger task, check its context first:
- `{{GET_WORKER_TOOL}}(id)` returns a `context` block — `{ used, limit, pct }`, where `pct` is the percent of the model window in use (`pct`/`limit` are null when the window is unknown — treat that as no signal, not as empty). `{{LIST_ACTIVE_WORKERS_TOOL}}()` returns a `context_pct` per worker. A worker past ~70% has little room left.
- If the follow-up won't comfortably fit in the remaining budget, do NOT pile it on. Spawn a fresh worker and hand the task off. Continuing a nearly-full worker gets slower, costlier, and less reliable as the model loses the head of its context.

Signals you will receive automatically:
- At 90% a heads-up arrives as `<system_message kind="context_threshold" stage="warn90" …>` naming the worker. It is a warning, not a stop — the worker is still running. Start planning a handoff.
- At context-full the worker is stopped automatically and you receive `<system_message kind="context_threshold" stage="full" …>`. The worker is now suspended, not killed: its branch and worktree stay intact for integration or resumption. No work is lost.

Handing off well:
- Use `get_worker_messages({ id, n })` to pull a worker's last N messages (n=5 for the recent thread, n=1 for just its latest) so you can brief the replacement with what it was doing and where it left off.
- Prefer integrating a suspended worker's branch over resuming it into an already-full context. If you must continue the same line of work, spawn a fresh worker seeded from the handoff summary.

Size tasks to fit. Work you can already see won't fit one worker's remaining budget should be split across workers up front — not discovered at 90%.
