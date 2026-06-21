---
description: "Orchestrator — Isolation"
variables:
  - INTEGRATE_WORKERS_TOOL
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

**`isolation: "worktree"`** (the default in a git repo) — the worker runs on its own `eos-*` branch, invisible to the checkout until the work is integrated.
- To bring the work into the checkout (to review it, build on it, or hand the operator one combined result), call `{{INTEGRATE_WORKERS_TOOL}}` — it merges your workers' branches onto yours (mechanics + outcome states in the tool description). The operator can also integrate per-worker via the dashboard's Try/diff deck. Until one of you does, the work is NOT in the checkout — don't tell the operator to run or look at it there yet. It merges files only; if the combined result must pass a build or test, that's a separate verification step — see the swarm playbook's fan-in.
- Report headers arrive as `[worker <name> (<id>)] reported (branch <eos-*>, worktree <dir>): <text>`. The branch/worktree in the header is authoritative even if the worker omitted its Handover line; relay the worker's `Handover:` line verbatim when present.
- If a worker claims `verified: passed` but the operator or dashboard reports a failing check → trust the actual check, not the claim.
- To follow up on existing work, `{{MESSAGE_WORKER_TOOL}}` the SAME worker — never read or edit its worktree from your own shell; you'd race it and bypass isolation.
- To put a SECOND agent on a worker's work (independent review, continuation, a fix) → spawn with `workspaceOf: <that worker id>`; it boots inside that worktree with direct file access. Allowed only while the target is idle — the spawn fails while it's busy.
- Don't `{{KILL_WORKER_TOOL}}` until the operator has integrated or explicitly discarded the work — see the tool's integrate-first brake for what an early kill destroys.

**`isolation: "cwd"`** — the worker runs directly in the operator's checkout; edits are immediately visible, there's no branch to integrate, and the worktree-invisibility rules above don't apply. In this mode, don't spawn parallel workers that could touch the same files — they share one checkout and one git index.
