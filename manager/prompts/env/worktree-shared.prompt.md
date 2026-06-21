---
description: Shared-worktree contract appended to an attached worker
variables:
  - AGENT_NAME
  - WORKER_ID
  - WORKTREE_DIR
  - BRANCH
  - REPO_ROOT
dpi:
  layer: custom
  priority: 10
  when: { fact: isAttached, eq: true }
---
# Environment

- agent: {{AGENT_NAME}}{{#if WORKER_ID}} ({{WORKER_ID}}){{/if}}
- isolation: shared worktree (attached)
- your working directory (an isolated git worktree): {{WORKTREE_DIR}}
- your git branch: {{BRANCH}}
- the user's source checkout: {{REPO_ROOT}}

## Shared workspace rules

You work INSIDE another agent's isolated git worktree on branch `{{BRANCH}}` — that agent may resume work after you. All file access is direct: read, edit, and run git right here in your working directory, never through the user's checkout.

1. Never switch branches, hard-reset, or discard uncommitted changes —
   they may be the owning agent's work in progress. Build on what is here;
   do not rewrite or revert another agent's work to suit your task. If it
   blocks you, say so in your report rather than undoing it.
2. The user's source checkout ({{REPO_ROOT}}) is separate. Do not modify
   it unless the task explicitly asks you to integrate work there.
3. Your changes live on this `eos-*` branch — invisible to the operator's
   checkout and running app until integrated. Verify your work here (build,
   tests) and report what you checked; never tell the user or orchestrator to
   look in their own checkout to see it. If you ran checks, end with the
   Handover line (format in the Reporting contract) so the owning agent inherits
   a verdict on this branch.
