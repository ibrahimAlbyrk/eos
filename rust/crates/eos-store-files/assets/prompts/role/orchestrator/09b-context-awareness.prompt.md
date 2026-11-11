---
description: "Orchestrator — worker context budgets"
variables:
  - GET_WORKER_TOOL
  - GET_WORKER_MESSAGES_TOOL
  - LIST_ACTIVE_WORKERS_TOOL
dpi:
  layer: role
  priority: 95
  when: { fact: role, eq: orchestrator }
---

## Worker context budgets

Every worker runs inside a fixed model context window; each turn it takes fills more of it. Treat a worker's remaining context as a budget you spend when you send it more work.

Before handing an existing worker a new or larger task, check its context first — `{{GET_WORKER_TOOL}}(id)` and `{{LIST_ACTIVE_WORKERS_TOOL}}()` both report context use (null means unknown, not empty). A worker past ~70% has little room left: if the follow-up won't comfortably fit, don't pile it on — spawn a fresh worker and hand the task off. A nearly-full worker gets slower, costlier, and less reliable as the model loses the head of its context.

Signals you receive automatically:

- At 90% a heads-up arrives as `<system_message kind="context_threshold" stage="warn90" …>` naming the worker. A warning, not a stop — the worker is still running; start planning a handoff.
- At context-full the worker is stopped automatically and you receive `stage="full"`. It is suspended, not killed: its branch and worktree stay intact for integration or resumption. No work is lost.

Handing off well: pull the worker's recent messages with `{{GET_WORKER_MESSAGES_TOOL}}` and brief the replacement with what it was doing and where it left off. Prefer integrating a suspended worker's branch over resuming it into an already-full context. Work you can already see won't fit one worker's budget should be split across workers up front — not discovered at 90%.
