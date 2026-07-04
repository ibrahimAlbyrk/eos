---
description: "MCP tool — kill_worker"
variables:
  - LIST_PENDING_PERMISSIONS_TOOL
  - INTEGRATE_WORKERS_TOOL
  - DYNAMIC_LOOP_TOOL
---

Terminate a worker via SIGTERM AND delete its worktree — the worker's `eos-*` branch and every un-integrated change on it are destroyed for good. Termination is graceful (the worker gets its Stop hook before exit). This is the only orchestrator tool with no undo, so the precondition below is a hard gate, not advice. Only works on workers you spawned.

When to use — only after the work is safe, or when there is nothing to lose:
1. The task is complete, the operator has acknowledged it, AND its branch is integrated ({{INTEGRATE_WORKERS_TOOL}}) or explicitly discarded — only then is killing "free a process," not "destroy work."
2. The worker is wedged with nothing worth saving — no progress events for a while, an infinite-loop pattern in events, or a `failed:` report with no recovery path.
3. The operator explicitly asks to cancel it.

When NOT to use:
- Before the worker's `eos-*` branch is integrated or explicitly discarded — SIGTERM destroys the worktree and its branch, so any un-integrated work is lost irreversibly. Pull it in with {{INTEGRATE_WORKERS_TOOL}} (or confirm the operator discarded it) FIRST; "free resources" is never worth silent data loss.
- When your only reason is "to free resources" or "tidy up the roster" — an idle worker costs nothing and stays consultable, so that reasoning never justifies the data loss. If that is the whole reason, don't.
- Only to STOP a goal loop — releasing the gate is {{DYNAMIC_LOOP_TOOL}} `op:"stop"` (keeps the worker and its work); kill also destroys the worktree.
- The worker just reported and the operator might want a follow-up — wait for the exchange to conclude first.
- During an active permission ask (worker in {{LIST_PENDING_PERMISSIONS_TOOL}}) — decide the permission first.

Returns `{ id, name, was_state, removed }` — `was_state` is what the worker was doing at SIGTERM; `removed: true` means its worktree (and any un-integrated work) is gone.
