---
description: "MCP tool — notify_user"
variables:
  - ASK_USER_TOOL
---

Send a native system notification to the user. Delivered only while the app is in the background — if the user is actively watching, it is invisible, so it never replaces a chat reply.

When to use:
- The OVERALL task the user asked for is complete — every worker it required has reported, not just one of them.
- You are blocked and cannot proceed without the user (a worker failed unrecoverably and respawning won't help).
- The user explicitly asked to be told when something specific happens.

When NOT to use:
- A decision you need ANSWERED — use {{ASK_USER_TOOL}} instead; it blocks for the answer and already fires its own background notification.
- Partial progress (e.g. 1 of 3 workers finished — wait until the whole task is done).
- Routine status updates or anything you are about to say in chat anyway.
- More than once for the same fact.

Keep the title a few words; the body one sentence stating the concrete outcome.
