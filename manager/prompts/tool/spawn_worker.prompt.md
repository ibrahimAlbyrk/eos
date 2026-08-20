---
description: "MCP tool — spawn_worker"
variables:
  - GET_WORKER_TOOL
  - KILL_WORKER_TOOL
  - MESSAGE_WORKER_TOOL
  - SEND_MESSAGE_TO_PARENT_TOOL
  - LIST_AVAILABLE_WORKERS_TOOL
  - LIST_ACTIVE_WORKERS_TOOL
  - LIST_PENDING_PERMISSIONS_TOOL
  - DYNAMIC_LOOP_TOOL
  - CREATE_WORKER_TOOL
---

Spawn a background worker to do concrete work. In a git repository the worker runs in an
ISOLATED git worktree on its own eos-* branch — NOT in your project directory; its
changes stay invisible to the user's checkout until integrated. Outside a git repo, or
with worktrees disabled in settings, it runs in your cwd — the result's `isolation`
field ("worktree" or "cwd") is authoritative; with "cwd", edits land directly in the
user's checkout, so avoid parallel workers touching the same files.

Two ways to spawn. Omit `from` for a plain one-off — the default, never wrong; inline
`toolsAllow`/`toolsDeny`/`editRegex` can fence a one-off's capability without defining
anything. Pass `from: "<name>"` to instantiate an available worker definition
({{LIST_AVAILABLE_WORKERS_TOOL}} lists them); it pre-fills that worker's defaults and
frames its instructions, and any field you pass explicitly still wins.

When NOT to use: read-only orchestration ({{GET_WORKER_TOOL}},
{{LIST_ACTIVE_WORKERS_TOOL}}, {{LIST_PENDING_PERMISSIONS_TOOL}}) — and not to DEFINE a
reusable blueprint: that is {{CREATE_WORKER_TOOL}}, then spawn with `from`.

Lifecycle: startup takes a few seconds. The worker receives `prompt` as its first
user-turn, runs until it calls {{SEND_MESSAGE_TO_PARENT_TOOL}}, then idles for
follow-ups ({{MESSAGE_WORKER_TOOL}}); retire it with {{KILL_WORKER_TOOL}} (integrate
first — see that tool).

`workspaceOf`: to review, continue, or fix an idle worker's work with direct file
access, boot the new worker INSIDE that worker's worktree (pass its id). Never inspect
another worker's worktree through your own shell.

Goal loop: when "done" has a concrete, checkable definition, pass `loop` to arm the goal
gate AT SPAWN — prefer this over a later {{DYNAMIC_LOOP_TOOL}} attach, which can miss a
report the worker sends before the loop exists. `loop.goal` = one-line `summary` +
`criteria[]` (each `{ id, text, verify? }`); give each criterion a `verify` shell
command wherever possible.

The worker inherits the project's worker system prompt — the reporting structure, the
result:/needs input:/failed: signal protocol, and the worktree Handover line are already
covered; do not repeat them in `prompt`.

Returns { id, isolation }.
