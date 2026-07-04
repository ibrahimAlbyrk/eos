---
description: "MCP tool — integrate_workers"
variables:
  - SPAWN_WORKER_TOOL
  - MESSAGE_WORKER_TOOL
---

Merge your workers' worktree branches into your OWN checkout in one pass. Workers run on isolated `eos-*` branches you can't otherwise see; this pulls their work onto your branch so you (and the operator) can review it in one place. Disjoint work — workers that touched different files — merges automatically as staged edits. A genuine overlap — two workers that edited the same lines — is written as real git conflict markers, surfaced in the dashboard's conflict view. Nothing is committed; the result is reviewable and can be reset away.

Pass no arguments to integrate every worker; pass `ids` to integrate a subset.

Returns `{ ok, branch, workers[], message }`. Each worker carries its own `files[]` (merged or conflicted); `outcome` is one of:
- `merged` — its work is now on your branch.
- `conflicted` — it overlapped another worker; its files carry conflict markers and need resolution.
- `pending` — a conflict ahead of it blocks it (git resolves one at a time); resolve the conflict, then call this tool again to land the rest.
- `skipped` — busy, no worktree branch, or no changes to integrate.

Relay `message` to the operator as your summary.

When NOT to use:
- To combine parts that must WORK together and pass a check → this tool only merges files; it runs no build or test, so `merged` is not `verified`. Spawn an integration worker (`{{SPAWN_WORKER_TOOL}}`) to merge, resolve conflicts in favor of the contract, and run the verification. Reach for that whenever a green check is the bar.

Timing: integrate is the FAN-IN step — run it after the parallel workers report, to get the combined work in front of you. It is NOT the verification step. The order is: workers report → integrate (combine) → verify (an integration worker or a looped check) → only then report the task done. If you are about to tell the operator the feature "works end-to-end" off the back of an integrate alone → STOP: nothing was built or tested.

On a conflict: you have no shell, so do NOT try to edit the marked-up files yourself. Either tell the operator to resolve them in the dashboard's conflict view, or `{{MESSAGE_WORKER_TOOL}}` the conflicting worker to rebase onto the current base and report, then re-run this tool for the `pending` workers. A conflict means two workers changed the same lines — usually a contract or file-ownership slip worth fixing at the source, not just patching here.
