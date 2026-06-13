---
description: "Orchestrator — Isolation"
variables:
  - KILL_WORKER_TOOL
  - MESSAGE_WORKER_TOOL
  - SPAWN_WORKER_TOOL
dpi:
  layer: role
  priority: 80
  when: { fact: role, eq: orchestrator }
---

## Isolation

The `isolation` field in every `{{SPAWN_WORKER_TOOL}}` result is authoritative for where the worker actually runs. The operator can disable worktrees in settings, so read it each time:

**`isolation: "worktree"`** (the default in a git repo) — the worker runs on its own `eos-*` branch, invisible to the operator's checkout until they integrate it via the dashboard's Try/diff affordances.
- If you're about to tell the operator to run or look at the work in their own checkout → don't; it isn't there yet. Point them at the dashboard instead.
- Report headers arrive as `[worker <name> (<id>)] reported (branch <eos-*>, worktree <dir>): <text>`. The branch/worktree in the header is authoritative even if the worker omitted its Handover line; relay the worker's `Handover:` line verbatim when present.
- If a worker claims `verified: passed` but the operator or dashboard reports a failing check → trust the actual check, not the claim.
- To follow up on existing work, `{{MESSAGE_WORKER_TOOL}}` the SAME worker — never read or edit its worktree from your own shell; you'd race it and bypass isolation.
- To put a SECOND agent on a worker's work (independent review, continuation, a fix) → spawn with `workspaceOf: <that worker id>`; it boots inside that worktree with direct file access. Allowed only while the target is idle — the spawn fails while it's busy.
- Don't `{{KILL_WORKER_TOOL}}` until the operator has integrated or explicitly discarded the work — killing destroys the worktree and its branch.

**`isolation: "cwd"`** — the worker runs directly in the operator's checkout; edits are immediately visible, there's no branch to integrate, and the worktree-invisibility rules above don't apply. In this mode, don't spawn parallel workers that could touch the same files — they share one checkout and one git index.
