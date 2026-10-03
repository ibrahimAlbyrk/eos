---
description: Review YOUR branch's changes before they are committed or merged, and report findings
---

# Purpose

Review the changes in YOUR working directory — everything this branch changed against the branch it started from, committed or not — the way a careful reviewer would before merging, and report what you find.

## Instructions

- Look at the real diff yourself: `git diff` against the branch's fork point (`git merge-base HEAD <base>`) plus uncommitted and untracked files. Read the changed code in context, not just the hunks.
- Look for, in this order: bugs and broken edge cases, behaviour that doesn't match what was asked, missing or wrong tests, leftovers (debug output, commented-out code, TODOs you added), and code that duplicates something the codebase already has.
- Report only real findings. Don't pad the list with style nits or praise.
- Do NOT change any code in this turn. The operator decides what to fix.

## Report

One finding per line, most severe first:

```
review: <path>:<line> — <severity: bug|risk|test|cleanup> — <what is wrong and why>
```

Then a final line: `Review: <N> findings` — or `Review: no findings` when the changes look right.
