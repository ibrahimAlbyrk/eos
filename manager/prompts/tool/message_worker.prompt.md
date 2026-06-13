---
description: "MCP tool — message_worker"
variables:
  - GET_WORKER_TOOL
  - SEND_MESSAGE_TO_PARENT_TOOL
---

Send a follow-up message to a running worker. The text becomes a new user-turn for the worker, starting a new directive cycle. Only works on workers you spawned.

When to use: after the worker has reported back (you received `[worker ... reported: ...]`) and the user wants a tweak, a redirect, a follow-up task, or wants to provide the input the worker asked for via `needs input:`.

When NOT to use:
- Before the worker has reported on its current directive — the worker is busy and your message will queue. Wait for the report.
- To ask 'any progress?' — that information is in {{GET_WORKER_TOOL}} if you really need it. Don't interrupt with redundant queries.

After messaging, the worker will resume on the new directive and eventually call {{SEND_MESSAGE_TO_PARENT_TOOL}} again. Same lifecycle rules apply.
