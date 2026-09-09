---
description: "MCP tool — kill_worker"
variables:
  - LIST_PENDING_PERMISSIONS_TOOL
  - INTEGRATE_WORKERS_TOOL
---

Terminate a worker via SIGTERM AND delete its worktree — its `eos-*` branch and every
un-integrated change on it are destroyed for good. Termination is graceful (the worker
gets its Stop hook). This is the only orchestrator tool with no undo, so the
precondition below is a hard gate, not advice. Only works on workers you spawned.

When to use:
1. The task is complete, the operator has acknowledged it, AND its branch is integrated
   ({{INTEGRATE_WORKERS_TOOL}}) or explicitly discarded.
2. The worker is wedged with nothing worth saving — no progress events for a while, an
   infinite-loop pattern, or a `failed:` report with no recovery path.
3. The operator explicitly asks to cancel it.

When NOT to use:
- Before the branch is integrated or explicitly discarded — integrate FIRST;
  un-integrated work is lost irreversibly.
- To "free resources" or tidy the roster — an idle worker costs nothing and stays
  consultable; that reason alone never justifies the data loss.
- Right after a report the operator may want to follow up on — let the exchange
  conclude.
- During an active permission ask (worker in {{LIST_PENDING_PERMISSIONS_TOOL}}) — decide
  the permission first.

Returns `{ id, name, was_state, removed }` — `removed: true` means the worktree and any
un-integrated work are gone.
