---
description: "MCP tool — kill_worker"
variables:
  - LIST_PENDING_PERMISSIONS_TOOL
---

Terminate a worker via SIGTERM. Termination is graceful (the worker gets its Stop hook before exit). Only works on workers you spawned.

When to use:
1. The worker's task is complete AND the user has acknowledged the result — frees resources.
2. The worker is stuck (no progress events for a while, infinite-loop pattern in events, or `failed:` report with no recovery path).
3. The user explicitly asks to cancel it.

When NOT to use:
- The worker just reported and the user might want a follow-up — wait for the exchange to conclude first.
- During an active permission ask (worker in {{LIST_PENDING_PERMISSIONS_TOOL}}) — decide the permission first.

Returns the worker's final state.
