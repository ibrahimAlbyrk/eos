---
description: "MCP tool — message_worker"
variables:
  - GET_WORKER_TOOL
  - SEND_MESSAGE_TO_PARENT_TOOL
  - SPAWN_WORKER_TOOL
---

Send a follow-up message to a running worker. The text becomes a new user-turn for the worker, starting a new directive cycle. Only works on workers you spawned.

When to use: after the worker has reported back (you received `[worker ... reported: ...]`) and the user wants a tweak, a redirect, a follow-up task, or wants to provide the input the worker asked for via `needs input:`.

When NOT to use:
- Before the worker has reported on its current directive — the worker is busy and your message will queue. Wait for the report.
- As a polling mechanism — to ask 'any progress?', that information is in {{GET_WORKER_TOOL}} if you really need it. Don't interrupt with redundant queries.
- When a SECOND agent needs direct file access to this worker's worktree (an independent review, an isolated fix) — message_worker only gives the SAME worker a new turn; {{SPAWN_WORKER_TOOL}} with `workspaceOf: <id>` to boot a fresh agent inside its (idle) worktree.
- For unrelated NEW work — {{SPAWN_WORKER_TOOL}} a fresh worker; don't pile an unrelated directive onto this worker's context.

After messaging, the worker will resume on the new directive and eventually call {{SEND_MESSAGE_TO_PARENT_TOOL}} again. Same lifecycle rules apply.
