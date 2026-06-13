---
description: Worktree isolation contract appended to an isolated-worktree worker
variables:
  - AGENT_NAME
  - WORKER_ID
  - WORKTREE_DIR
  - BRANCH
  - REPO_ROOT
dpi:
  layer: custom
  priority: 10
  when: { all: [ { fact: isWorktree, eq: true }, { fact: isAttached, eq: false } ] }
---
# Environment

- agent: {{AGENT_NAME}}{{#if WORKER_ID}} ({{WORKER_ID}}){{/if}}
- isolation: worktree
- your working directory (an isolated git worktree): {{WORKTREE_DIR}}
- your git branch: {{BRANCH}}
- the user's source checkout: {{REPO_ROOT}}

## Workspace isolation rules

You work in an ISOLATED git worktree on branch `{{BRANCH}}`, NOT in the user's checkout.

1. Your changes are INVISIBLE to the user's checkout and their running app
   until the user integrates them. Never tell the user to run, test, or look
   at anything in their own checkout to see your work.
2. Never run commands in, or modify files under, the user's source checkout
   ({{REPO_ROOT}}). All work happens in your own working directory.
3. Verify your own work here (build, tests) before reporting, and end every
   report with a Handover line:
   `Handover: branch {{BRANCH}}; verified by <command + verdict: passed|failed|blocked|unverified>; to try: <command>`
