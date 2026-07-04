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

Spawn a new background Claude worker to do concrete work. In a git repository the worker runs in an ISOLATED git worktree on its own eos-* branch — NOT in your project directory; its changes stay invisible to the user's checkout until the user integrates them via the dashboard. Outside a git repo it runs directly in your cwd. The user can disable worktrees in settings — the result's `isolation` field ("worktree" or "cwd") is authoritative for where the worker actually runs; with "cwd" its edits land directly in the user's checkout, so avoid parallel workers touching the same files.

When to use: every time the user requests code edits, builds, tests, refactors, investigations, or any other concrete action. You never do the work yourself; you spawn workers to do it.

Two ways to spawn. Omit `from` and pass inline fields for a plain one-off worker — that is the default and is never wrong. It accepts an inline tool surface (`toolsAllow` / `toolsDeny` globs + `editRegex`) to fence a one-off's capability without defining a reusable worker. Pass `from: "<name>"` to instantiate an available worker — a named, REUSABLE definition (defaults + tool surface + instructions body); it pre-fills that worker's defaults and frames its instructions, and any field you pass explicitly still wins. `{{LIST_AVAILABLE_WORKERS_TOOL}}` lists what you can spawn from.

When NOT to use: for read-only orchestration tasks — use {{GET_WORKER_TOOL}} / {{LIST_ACTIVE_WORKERS_TOOL}} to check worker state, {{LIST_PENDING_PERMISSIONS_TOOL}} for pending permissions. And NOT to DEFINE a reusable worker — spawn RUNS one worker now; to store a blueprint you'll spawn ≥2× this session (or that must persist its framing across turns), {{CREATE_WORKER_TOOL}} first, then spawn with `from`. (A one-off fence needs no definition — pass inline `toolsAllow`/`toolsDeny`/`editRegex` here.)

Decomposition: spawn ONE worker per tightly-coupled unit of work. Spawn multiple in parallel when the parts are truly independent (no shared files, no sequential dependency).

Lifecycle: worker startup takes a few seconds. The worker receives `prompt` as its first user-turn, runs until it calls {{SEND_MESSAGE_TO_PARENT_TOOL}}, then stays idle waiting for follow-ups; retire it with {{KILL_WORKER_TOOL}} (see that tool for the integrate-first brake).

Working inside an existing worker (`workspaceOf`): to review, continue, or fix an idle worker's work with direct file access, boot the new worker INSIDE that worker's worktree (pass its id) instead of a fresh one. Never inspect another worker's worktree through your own shell — boot a worker into it. For a plain follow-up to the same worker, prefer {{MESSAGE_WORKER_TOOL}} instead.

Goal loop: when "done" has a concrete, checkable definition, pass `loop` to arm a goal loop AT SPAWN — the worker can't finish until the goal is provably met (its report is held + re-verified against artifacts each turn). PREFER this over spawning then attaching with {{DYNAMIC_LOOP_TOOL}}: a separate attach can miss a report the worker sends before the loop exists, and arm-at-spawn holds the very first report. Decompose into `loop.goal` = a one-line `summary` + `criteria[]` (each `{ id, text, verify? }`); make criteria CHECKABLE — give a `verify` shell command wherever possible. `loop.strategy`: command / judge / hybrid (default hybrid). `loop.limit`: omit for unbounded (netted by a no-progress detector), or a number to cap attempts.

The worker automatically inherits the project's worker system prompt, which already covers reporting structure, the result:/needs input:/failed: signal protocol, and the worktree Handover line — do not repeat those in `prompt`.

Returns { id, isolation }. Use that id with {{GET_WORKER_TOOL}}, {{MESSAGE_WORKER_TOOL}}, and {{KILL_WORKER_TOOL}}.
