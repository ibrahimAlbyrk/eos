---
description: "MCP tool — message_worker"
variables:
  - GET_WORKER_TOOL
  - SEND_MESSAGE_TO_PARENT_TOOL
  - SPAWN_WORKER_TOOL
---

Send a follow-up to a worker you spawned. The text becomes a new user-turn, starting a
new directive cycle.

When to use: after the worker has reported (you received its `<agent_message …>`) and
you have a tweak, a redirect, a follow-up task, or the input it asked for via
`needs input:`. The worker sees your text tagged `<agent_message from="<you>">`,
distinct from an untagged operator turn.

When NOT to use:
- Before the worker reports on its current directive — it is busy and your message will
  queue. Wait for the report.
- As polling ("any progress?") — that information is in {{GET_WORKER_TOOL}} if truly
  needed.
- When a SECOND agent needs direct file access to this worker's worktree — that is
  {{SPAWN_WORKER_TOOL}} with `workspaceOf: <id>`; this tool only gives the SAME worker a
  new turn.
- For unrelated NEW work — spawn a fresh worker rather than piling an unrelated
  directive onto this worker's context.

The worker resumes on the new directive and eventually calls
{{SEND_MESSAGE_TO_PARENT_TOOL}} again; the same lifecycle rules apply.
