---
description: "MCP tool — spawn_worker"
variables:
  - GET_WORKER_TOOL
  - KILL_WORKER_TOOL
  - MESSAGE_WORKER_TOOL
  - SEND_MESSAGE_TO_PARENT_TOOL
---

Spawn a new background Claude worker to do concrete work. In a git repository the worker runs in an ISOLATED git worktree on its own eos-* branch — NOT in your project directory; its changes stay invisible to the user's checkout until the user integrates them via the dashboard. Outside a git repo it runs directly in your cwd. The user can disable worktrees in settings — the result's `isolation` field ("worktree" or "cwd") is authoritative for where the worker actually runs; with "cwd" its edits land directly in the user's checkout, so avoid parallel workers touching the same files.

When to use: every time the user requests code edits, builds, tests, refactors, investigations, or any other concrete action. You never do the work yourself; you spawn workers to do it.

When NOT to use: for read-only orchestration tasks (checking worker state, listing pending permissions) — use the dedicated tools for those.

Decomposition: spawn ONE worker per tightly-coupled unit of work. Spawn multiple in parallel when the parts are truly independent (no shared files, no sequential dependency).

Lifecycle: worker startup takes a few seconds. The worker receives `prompt` as its first user-turn, runs until it calls {{SEND_MESSAGE_TO_PARENT_TOOL}}, then stays idle waiting for follow-ups. Call {{KILL_WORKER_TOOL}} only after the user has acknowledged the result AND integrated or discarded the worker's branch — deleting a worker destroys its worktree.

The worker automatically inherits the project's worker system prompt, which already covers reporting structure, the result:/needs input:/failed: signal protocol, and the worktree Handover line — do not repeat those in `prompt`.

Returns { id, port, isolation }. Use that id with {{GET_WORKER_TOOL}}, {{MESSAGE_WORKER_TOOL}}, and {{KILL_WORKER_TOOL}}.
