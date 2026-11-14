---
description: Merge several Eos agent worktree branches into one verified result
variables:
  - BRANCHES
---

Merge these Eos agent worktree branches into your current branch, one at a time: {{BRANCHES}}

They are live agent worktrees — never check them out or delete them; merge their branches by name (they share this repo's git). Resolve conflicts preserving both sides' intent. After merging, run the project's own checks (build/tests as the repo uses them) and fix any integration breakage you introduced by combining the branches. Report which branches you merged, the conflicts you resolved, and the verification result.
