---
description: Rebase the current branch onto a target branch with lock handling, conflict policy, and submodule pointer alignment
argument-hint: "[target branch]"
variables:
  - TARGET
---

# Purpose

Rebase the current branch onto `TARGET_BRANCH` by following the `Instructions` and `Workflow` exactly. Handles `.git/index.lock` collisions caused by an open editor (e.g. Unity) by deleting the lock and retrying, applies the conflict policy (auto-resolve pure-additive, ask on overlap), and re-aligns submodule worktrees so builds don't run against stale submodule commits.

## Variables

TARGET_BRANCH: {{TARGET}}
CURRENT_BRANCH: resolve with `git rev-parse --abbrev-ref HEAD`; reject "HEAD" (detached)

## Instructions

- Treat `index.lock` failures as transient: when a git command fails with `index.lock: File exists`, delete that exact lock file and re-run the command. No retry cap, no user prompt — the lock is stale because external editors do not run git themselves.
- Before touching anything, verify: working tree clean (`git status --porcelain` empty), no rebase in progress (`.git/rebase-merge` and `.git/rebase-apply` absent), `TARGET_BRANCH` resolvable (`git rev-parse --verify`; if not, also try `origin/<target>`). Abort with a clear message if any check fails.
- Run `git fetch origin --recurse-submodules=no` once at the start so `TARGET_BRANCH` is up-to-date if it's a remote-tracking ref. Do not auto-pull.
- Apply the conflict policy strictly:
  - **Pure-additive conflicts** (both sides add disjoint lines without overlapping any existing line) → auto-resolve by union (both sides in original order, current branch first) and continue.
  - **Same-line / overlapping changes** → always ask the user in chat (end your turn and wait for their reply; `AskUserQuestion` is disabled in Eos) with three options: "Take ours (current branch)", "Take theirs (target/incoming)", "Show diff and let me decide". Do not guess.
  - During rebase, remember the role inversion: `--theirs` in `git checkout --theirs <file>` is the incoming feature commit (= the user's "ours"); `--ours` is the rebased base. Surface this clearly when asking.
- Never use `--no-verify`, `--force` without `--lease`, or `git reset --hard` outside explicit user-driven recovery. Never push.
- If the repo has submodules: after a successful rebase, run `git submodule status` and detect entries marked `+` (worktree HEAD ≠ recorded pointer). For each, run `git submodule update --init -- <path>` with the same lock-delete-and-retry strategy applied to that submodule's `.git/modules/<path>/index.lock`. Report any that still diverge.

## Workflow

1. **Validate**
   - Resolve `CURRENT_BRANCH`; abort on detached HEAD.
   - Verify `TARGET_BRANCH` is resolvable; if not, try `origin/<target>`; otherwise abort.

2. **Pre-flight checks**
   - `git status --porcelain` → must be empty. If not, abort and show the dirty files.
   - `.git/rebase-merge` / `.git/rebase-apply` must not exist. If they do, abort and tell the user to `git rebase --abort` first.

3. **Fetch**
   - `git fetch origin --recurse-submodules=no`.
   - Print: merge-base, commits ahead (`CURRENT_BRANCH` vs `TARGET_BRANCH`), commits behind.

4. **Submodule pre-scan (informational, skip if no submodules)**
   - Diff `Subproject` pointer movements on both sides (`git diff <merge-base>..<target> | grep "^[-+]Subproject"` and the symmetric diff). Identify pointers that move on both sides (true conflict) vs one side only (clean replay). Print the table; do not modify submodules yet.

5. **Start rebase**
   - `git rebase "$TARGET_BRANCH"`. On an `index.lock` error, parse the exact lock path from stderr, `rm` it, re-run. Repeat until a non-lock outcome (success, conflict, or different error).

6. **Resolve conflicts iteratively**
   - On `CONFLICT`, list unmerged paths with `git diff --name-only --diff-filter=U`.
   - For each conflicted file: read it, classify each `<<<<<<<`/`=======`/`>>>>>>>` hunk as additive vs overlap; auto-resolve additive hunks via union; ask the user on overlap hunks, quoting both sides verbatim (truncate to ~30 lines per side).
   - Stage resolved files with `git add` (lock-delete-and-retry), then `git rebase --continue`. Loop until "Successfully rebased and updated".

7. **Sync submodule worktrees (skip if no submodules)**
   - `git submodule status` → rows starting with `+` → `git submodule update --init -- <path>` each, with lock handling. Re-check; report rows that still diverge as warnings (do not fail).

8. **Final verification**
   - `git status` → must be clean.
   - `git log --oneline "$TARGET_BRANCH..HEAD"` → commits replayed on the new base; capture the count for the report.

## Report

Send a single concise message with:

1. **Result** — "Rebase complete" or "Rebase paused/aborted at step <N>: <reason>".
2. **Branches** — `CURRENT_BRANCH` → `TARGET_BRANCH`, plus the resulting HEAD short SHA.
3. **Replay stats** — commits replayed, commits in target now ahead of the prior base, dropped commits if any.
4. **Conflicts handled** — bullet list `<file>: auto-additive` or `<file>: user-chose-ours/theirs`.
5. **Submodules** — bullets for any re-synced; flag any that still diverge.
6. **Next step** — remind: the branch is now ahead of `origin/<current>`; push with `git push --force-with-lease` when ready (never automatically).

If you asked the user a question at any step, include a one-line summary of each decision.
